"use server"

import { query, queryOne } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"

async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized")
}

// Longest custom appeal message we'll forward to @SpamBot.
const MAX_APPEAL_TEXT = 1000

type AppealResult = {
  ok?: boolean
  error?: string
  queued?: number
  alreadyRunning?: boolean
}

/**
 * Ask the Python agent to file a freeze appeal for SPECIFIC frozen accounts.
 * One `appeal_frozen` job is enqueued per account (each carries account_id so it
 * runs on the shard that owns that account). A custom appeal message is optional
 * — when omitted the agent uses its default text with @SpamBot.
 *
 * Accounts that already have an appeal in flight (appeal_status 'queued' or
 * 'appealing') are skipped so a double-click can't stack duplicate jobs.
 */
export async function appealAccounts(input: {
  accountIds: number[]
  appealText?: string
}): Promise<AppealResult> {
  await requireAuth()

  const ids = (input.accountIds ?? []).map((n) => Math.floor(Number(n))).filter((n) => Number.isFinite(n) && n > 0)
  if (ids.length === 0) return { error: "Select at least one frozen account." }

  const appealText = (input.appealText ?? "").trim().slice(0, MAX_APPEAL_TEXT) || null

  // Only appeal accounts that are actually frozen and not already being appealed.
  const rows = await query<{ id: number }>(
    `SELECT id FROM telegram_accounts
      WHERE id = ANY($1::int[])
        AND status = 'frozen'
        AND (appeal_status IS NULL OR appeal_status NOT IN ('queued','appealing'))`,
    [ids],
  )
  if (rows.length === 0) return { ok: true, queued: 0, alreadyRunning: true }

  const payload = appealText ? { appeal_text: appealText } : {}
  for (const r of rows) {
    await query(
      `INSERT INTO jobs (type, account_id, payload, status) VALUES ($1, $2, $3::jsonb, 'queued')`,
      ["appeal_frozen", r.id, JSON.stringify(payload)],
    )
    await query(
      `UPDATE telegram_accounts SET appeal_status = 'queued', appeal_result = NULL, updated_at = now() WHERE id = $1`,
      [r.id],
    )
  }

  revalidatePath("/")
  return { ok: true, queued: rows.length }
}

/**
 * Appeal EVERY frozen account at once. This enqueues a SINGLE fan-out
 * `appeal_frozen` job (no account_id) which shard 0 expands to every shard, so
 * each shard appeals its own frozen bots. Avoids piling up duplicate fan-outs
 * if one is already pending.
 */
export async function appealAllFrozen(input?: { appealText?: string }): Promise<AppealResult> {
  await requireAuth()

  const pending = await queryOne<{ id: number }>(
    `SELECT id FROM jobs WHERE type = 'appeal_frozen' AND account_id IS NULL AND status IN ('queued','processing') LIMIT 1`,
  )
  if (pending) return { ok: true, alreadyRunning: true }

  const frozen = await query<{ id: number }>(`SELECT id FROM telegram_accounts WHERE status = 'frozen'`)
  if (frozen.length === 0) return { ok: true, queued: 0 }

  const appealText = (input?.appealText ?? "").trim().slice(0, MAX_APPEAL_TEXT) || null
  const payload = appealText ? { appeal_text: appealText } : {}

  await query(`INSERT INTO jobs (type, account_id, payload, status) VALUES ($1, NULL, $2::jsonb, 'queued')`, [
    "appeal_frozen",
    JSON.stringify(payload),
  ])
  // Mark all frozen accounts as queued so the UI reflects the batch immediately.
  await query(
    `UPDATE telegram_accounts SET appeal_status = 'queued', appeal_result = NULL, updated_at = now() WHERE status = 'frozen'`,
  )

  revalidatePath("/")
  return { ok: true, queued: frozen.length }
}
