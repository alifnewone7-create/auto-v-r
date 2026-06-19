"use server"

import { query, queryOne } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"
import type { LivestreamTarget, TelegramAccount } from "@/lib/types"

async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized")
}

async function enqueueJob(type: string, accountId: number | null, payload: Record<string, any> = {}) {
  await query(`INSERT INTO jobs (type, account_id, payload, status) VALUES ($1, $2, $3::jsonb, 'queued')`, [
    type,
    accountId,
    JSON.stringify(payload),
  ])
}

/**
 * Join a live stream / video chat. Creates a target, then queues one
 * `join_livestream` job per logged-in userbot so they all join in parallel.
 * The Python agent makes each userbot join the chat and then its active group
 * call in listen-only mode.
 */
export async function joinLivestream(formData: FormData) {
  await requireAuth()
  const link = String(formData.get("chat_link") ?? "").trim()
  if (!link) return { error: "Channel / group link is required." }

  const accounts = await query<TelegramAccount>(`SELECT * FROM telegram_accounts WHERE status = 'logged_in'`)
  if (accounts.length === 0) return { error: "No logged-in userbots available. Add and log in an account first." }

  const target = await queryOne<LivestreamTarget>(
    `INSERT INTO livestream_targets (chat_link, status, total_count, joined_count)
     VALUES ($1, 'joining', $2, 0) RETURNING *`,
    [link, accounts.length],
  )

  for (const acc of accounts) {
    await query(
      `INSERT INTO livestream_participants (target_id, account_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (target_id, account_id) DO UPDATE SET status = 'pending', last_error = NULL`,
      [target!.id, acc.id],
    )
    await enqueueJob("join_livestream", acc.id, { target_id: target!.id, chat_link: link })
  }

  revalidatePath("/")
  return { ok: true, count: accounts.length }
}

/** Make all userbots leave a live stream target. */
export async function leaveLivestream(targetId: number) {
  await requireAuth()
  const participants = await query<{ account_id: number }>(
    `SELECT account_id FROM livestream_participants WHERE target_id = $1 AND status = 'joined'`,
    [targetId],
  )
  await query(`UPDATE livestream_targets SET status = 'leaving', updated_at = now() WHERE id = $1`, [targetId])
  for (const p of participants) {
    await enqueueJob("leave_livestream", p.account_id, { target_id: targetId })
  }
  revalidatePath("/")
  return { ok: true }
}

export async function deleteLivestream(targetId: number) {
  await requireAuth()
  await query(`DELETE FROM livestream_participants WHERE target_id = $1`, [targetId])
  await query(`DELETE FROM livestream_targets WHERE id = $1`, [targetId])
  revalidatePath("/")
  return { ok: true }
}
