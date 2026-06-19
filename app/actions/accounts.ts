"use server"

import { query, queryOne } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"
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

export async function deleteAccount(accountId: number) {
  await requireAuth()
  await query(`DELETE FROM livestream_participants WHERE account_id = $1`, [accountId])
  await query(`DELETE FROM jobs WHERE account_id = $1`, [accountId])
  await query(`DELETE FROM telegram_accounts WHERE id = $1`, [accountId])
  revalidatePath("/")
  return { ok: true }
}
