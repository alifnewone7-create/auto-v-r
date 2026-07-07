"use server"

import { query, queryOne } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"
import { buyNumber, TgLionError } from "@/lib/tglion"
import type { TelegramAccount } from "@/lib/types"

async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized")
}

async function enqueueJob(type: string, accountId: number | null, payload: Record<string, any> = {}) {
  await query(
    `INSERT INTO jobs (type, account_id, payload, status) VALUES ($1, $2, $3::jsonb, 'queued')`,
    [type, accountId, JSON.stringify(payload)],
  )
}

/**
 * Step 1: Add an account. Stores the number + app title/short name, then queues
 * a `create_app` job. The Python agent logs into my.telegram.org/auth and, once
 * it submits the phone, Telegram sends a login code (inside the Telegram app).
 * The account moves to `api_code` so the UI shows a code input.
 */
export async function addAccount(formData: FormData) {
  await requireAuth()
  const phone = String(formData.get("phone") ?? "").trim()
  const label = String(formData.get("label") ?? "").trim() || null
  const appTitle = String(formData.get("app_title") ?? "Iamhear").trim() || "Iamhear"
  const shortName = String(formData.get("short_name") ?? "iamheardeveloper").trim() || "iamheardeveloper"

  if (!phone) return { error: "Phone number is required." }
  if (!/^\+?\d{6,15}$/.test(phone.replace(/\s/g, "")))
    return { error: "Enter a valid phone number with country code, e.g. +8801XXXXXXXXX" }

  const existing = await queryOne<TelegramAccount>(`SELECT id FROM telegram_accounts WHERE phone_number = $1`, [phone])
  if (existing) return { error: "This phone number is already added." }

  const account = await queryOne<TelegramAccount>(
    `INSERT INTO telegram_accounts (label, phone_number, app_title, short_name, status)
     VALUES ($1, $2, $3, $4, 'api_pending') RETURNING *`,
    [label, phone, appTitle, shortName],
  )

  await enqueueJob("create_app", account!.id, { phone, app_title: appTitle, short_name: shortName })
  revalidatePath("/")
  return { ok: true }
}

/**
 * tg-lion auto-buy: purchase a number from the chosen country, create the
 * account row, and queue ONE `provision_tglion` job. The Python agent then runs
 * the whole flow automatically (reads the login code from tg-lion, collects
 * api_id/api_hash, logs the userbot in, turns off the old 2FA and sets our new
 * one) — no codes are ever typed by hand.
 */
export async function buyTgLionNumber(formData: FormData) {
  await requireAuth()
  const countryCode = String(formData.get("country_code") ?? "").trim()
  const maxPrice = String(formData.get("max_price") ?? "").trim() || undefined
  const label = String(formData.get("label") ?? "").trim() || null
  if (!countryCode) return { error: "Please choose a country." }

  let bought
  try {
    bought = await buyNumber(countryCode, maxPrice)
  } catch (e: any) {
    return { error: e instanceof TgLionError ? e.message : (e?.message ?? "Failed to buy a number.") }
  }

  const phone = bought.Number.startsWith("+") ? bought.Number : `+${bought.Number}`

  const existing = await queryOne<TelegramAccount>(`SELECT id FROM telegram_accounts WHERE phone_number = $1`, [phone])
  if (existing) {
    return { error: `tg-lion returned ${phone} which is already in the system.` }
  }

  const account = await queryOne<TelegramAccount>(
    `INSERT INTO telegram_accounts (label, phone_number, status, source, country_code)
     VALUES ($1, $2, 'purchased', 'tglion', $3) RETURNING *`,
    [label, phone, countryCode],
  )

  await enqueueJob("provision_tglion", account!.id, { phone, country_code: countryCode })
  revalidatePath("/")
  return { ok: true, phone, price: bought.price, new_balance: bought.new_balance }
}

/**
 * Step 1b: Submit the my.telegram.org login code so the agent can finish logging
 * in and create the application (api_id / api_hash).
 */
export async function submitMtprotoCode(formData: FormData) {
  await requireAuth()
  const accountId = Number(formData.get("account_id"))
  const code = String(formData.get("code") ?? "").trim()
  if (!accountId || !code) return { error: "Code is required." }

  await query(`UPDATE telegram_accounts SET status = 'api_pending', updated_at = now() WHERE id = $1`, [accountId])
  await enqueueJob("submit_mtproto_code", accountId, { code })
  revalidatePath("/")
  return { ok: true }
}

/**
 * Step 2: "Verify" — request a userbot login code. Uses the collected
 * api_id/api_hash to send a login code to the phone via Telegram.
 */
export async function startLogin(accountId: number) {
  await requireAuth()
  const account = await queryOne<TelegramAccount>(`SELECT * FROM telegram_accounts WHERE id = $1`, [accountId])
  if (!account) return { error: "Account not found." }
  if (!account.api_id || !account.api_hash) return { error: "API not collected yet for this account." }

  await query(`UPDATE telegram_accounts SET status = 'login_pending', updated_at = now() WHERE id = $1`, [accountId])
  await enqueueJob("send_login_code", accountId, {})
  revalidatePath("/")
  return { ok: true }
}

/**
 * Step 2b: Submit the userbot login code (and 2FA password if required). On
 * success the agent stores the session string and the account becomes
 * `logged_in` — ready to join live streams.
 */
export async function submitLoginCode(formData: FormData) {
  await requireAuth()
  const accountId = Number(formData.get("account_id"))
  const code = String(formData.get("code") ?? "").trim()
  const password = String(formData.get("password") ?? "").trim()
  if (!accountId || !code) return { error: "Login code is required." }

  await query(`UPDATE telegram_accounts SET status = 'login_pending', updated_at = now() WHERE id = $1`, [accountId])
  await enqueueJob("submit_login_code", accountId, { code, password: password || null })
  revalidatePath("/")
  return { ok: true }
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped double quotes
 * ("") and commas/newlines inside quotes. Returns an array of string arrays.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let inQuotes = false
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += c
    }
  }
  // flush last field/row (ignore a trailing empty line)
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Bulk-import accounts from an uploaded CSV export (same shape as the
 * telegram_accounts table). Upserts by phone_number so re-uploading updates
 * existing rows instead of duplicating them. Empty api_id/api_hash/session
 * fields are preserved as NULL.
 */
export async function importAccountsCsv(formData: FormData) {
  await requireAuth()
  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { error: "Please choose a CSV file." }

  const text = await file.text()
  const rows = parseCsv(text)
  if (rows.length < 2) return { error: "CSV has no data rows." }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const idx = (name: string) => header.indexOf(name)
  const phoneIdx = idx("phone_number")
  if (phoneIdx === -1) return { error: "CSV must include a 'phone_number' column." }

  const iLabel = idx("label")
  const iAppTitle = idx("app_title")
  const iShortName = idx("short_name")
  const iApiId = idx("api_id")
  const iApiHash = idx("api_hash")
  const iSession = idx("session_string")
  const iStatus = idx("status")
  const i2fa = idx("two_factor_required")
  const iLastError = idx("last_error")
  const iMtproto = idx("mtproto_hash")
  const iLogin = idx("login_hash")

  const cell = (row: string[], i: number) => (i >= 0 && i < row.length ? row[i].trim() : "")
  const orNull = (v: string) => (v === "" ? null : v)

  let inserted = 0
  let updated = 0
  let skipped = 0
  const errors: string[] = []

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const phone = cell(row, phoneIdx)
    if (!phone) {
      skipped++
      continue
    }
    if (!/^\+?\d{6,15}$/.test(phone.replace(/\s/g, ""))) {
      errors.push(`Row ${r + 1}: invalid phone "${phone}"`)
      skipped++
      continue
    }

    const twoFactorRaw = cell(row, i2fa).toLowerCase()
    const twoFactor = twoFactorRaw === "true" || twoFactorRaw === "t" || twoFactorRaw === "1"
    const status = orNull(cell(row, iStatus)) ?? "new"

    try {
      const res = await queryOne<{ inserted: boolean }>(
        `INSERT INTO telegram_accounts
           (label, phone_number, app_title, short_name, api_id, api_hash,
            session_string, status, two_factor_required, last_error,
            mtproto_hash, login_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (phone_number) DO UPDATE SET
           label               = EXCLUDED.label,
           app_title           = EXCLUDED.app_title,
           short_name          = EXCLUDED.short_name,
           api_id              = EXCLUDED.api_id,
           api_hash            = EXCLUDED.api_hash,
           session_string      = EXCLUDED.session_string,
           status              = EXCLUDED.status,
           two_factor_required = EXCLUDED.two_factor_required,
           last_error          = EXCLUDED.last_error,
           mtproto_hash        = EXCLUDED.mtproto_hash,
           login_hash          = EXCLUDED.login_hash,
           updated_at          = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          orNull(cell(row, iLabel)),
          phone,
          orNull(cell(row, iAppTitle)) ?? "Iamhear",
          orNull(cell(row, iShortName)) ?? "iamheardeveloper",
          orNull(cell(row, iApiId)),
          orNull(cell(row, iApiHash)),
          orNull(cell(row, iSession)),
          status,
          twoFactor,
          orNull(cell(row, iLastError)),
          orNull(cell(row, iMtproto)),
          orNull(cell(row, iLogin)),
        ],
      )
      if (res?.inserted) inserted++
      else updated++
    } catch (err: any) {
      errors.push(`Row ${r + 1} (${phone}): ${err?.message ?? "insert failed"}`)
      skipped++
    }
  }

  revalidatePath("/")
  return { ok: true, inserted, updated, skipped, errors }
}

export async function deleteAccount(accountId: number) {
  await requireAuth()
  await query(`DELETE FROM livestream_participants WHERE account_id = $1`, [accountId])
  await query(`DELETE FROM jobs WHERE account_id = $1`, [accountId])
  await query(`DELETE FROM telegram_accounts WHERE id = $1`, [accountId])
  revalidatePath("/")
  return { ok: true }
}
