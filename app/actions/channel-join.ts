"use server"

import { query, queryOne, LIVE_BUSY_STATUSES, notInLiveSql } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"
import { isTelegramLink } from "@/lib/validation"
import type { ChannelJoinTarget, TelegramAccount } from "@/lib/types"

async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized")
}

// Queue one `join_channel` job per account in a SINGLE round-trip (UNNEST), the
// same batch pattern the livestream join uses. This keeps starting a 500-1000
// bot join fast and inside serverless limits instead of ~2 queries per bot.
async function enqueueJoinBatch(targetId: number, chatLink: string, accountIds: number[]) {
  if (accountIds.length === 0) return
  await query(
    `INSERT INTO channel_join_participants (target_id, account_id, status)
     SELECT $1, uid, 'pending' FROM unnest($2::int[]) AS uid
     ON CONFLICT (target_id, account_id) DO UPDATE SET status = 'pending', last_error = NULL`,
    [targetId, accountIds],
  )
  await query(
    `INSERT INTO jobs (type, account_id, payload, status)
     SELECT 'join_channel', uid,
            jsonb_build_object('target_id', $1::int, 'chat_link', $2::text), 'queued'
     FROM unnest($3::int[]) AS uid`,
    [targetId, chatLink, accountIds],
  )
}

// Recompute the target's counts + status from its participant rows so the card
// always reflects reality (used after retry so status flips back to 'joining').
async function recount(targetId: number) {
  await query(
    `UPDATE channel_join_targets t SET
        joined_count = s.joined,
        failed_count = s.failed,
        total_count  = s.total,
        status = CASE
                   WHEN s.pending > 0 THEN 'joining'
                   WHEN s.failed = 0 THEN 'done'
                   WHEN s.joined = 0 THEN 'failed'
                   ELSE 'partial'
                 END,
        updated_at = now()
     FROM (
       SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status IN ('joined','already_member'))::int AS joined,
         count(*) FILTER (WHERE status = 'failed')::int AS failed,
         count(*) FILTER (WHERE status IN ('pending','joining'))::int AS pending
       FROM channel_join_participants WHERE target_id = $1
     ) s
     WHERE t.id = $1`,
    [targetId],
  )
}

/**
 * Join a channel / group with every logged-in userbot (or a chosen number).
 *
 * Getting the userbots INTO the chat first is what makes later view / react /
 * vote actions reliable. Creates a target, then queues one `join_channel` job
 * per selected userbot. The Python agent joins each one idempotently: already a
 * member counts as success, and expired / wrong / banned links are skipped
 * per-bot with a clear reason — nothing ever crashes the agent.
 */
export async function joinChannel(formData: FormData) {
  await requireAuth()

  const link = String(formData.get("chat_link") ?? "").trim()
  if (!link) return { error: "Channel / group link is required." }
  if (!isTelegramLink(link)) return { error: "Enter a valid Telegram link." }

  // How many userbots to send in. Blank / 0 -> use every logged-in bot.
  const rawCount = String(formData.get("count") ?? "").trim()
  const requested = rawCount === "" ? 0 : Number.parseInt(rawCount, 10)
  if (rawCount !== "" && (!Number.isFinite(requested) || requested < 0)) {
    return { error: "Enter a valid number of userbots (or leave blank for all)." }
  }

  const allAccounts = await query<TelegramAccount>(
    // Random order so a partial count spreads across different accounts.
    // Accounts reserved for a live stream are skipped (no other work while live).
    `SELECT a.* FROM telegram_accounts a
      WHERE a.status = 'logged_in'
        AND ${notInLiveSql("a", 1)}
      ORDER BY random()`,
    [LIVE_BUSY_STATUSES],
  )
  if (allAccounts.length === 0) {
    return { error: "No logged-in userbots available. Add and log in an account first." }
  }

  const take = requested > 0 ? Math.min(requested, allAccounts.length) : allAccounts.length
  const accounts = allAccounts.slice(0, take)

  const target = await queryOne<ChannelJoinTarget>(
    `INSERT INTO channel_join_targets (chat_link, status, total_count)
     VALUES ($1, 'joining', $2) RETURNING *`,
    [link, accounts.length],
  )

  await enqueueJoinBatch(
    target!.id,
    link,
    accounts.map((a) => a.id),
  )

  revalidatePath("/")
  return { ok: true, count: accounts.length, available: allAccounts.length }
}

/**
 * Retry only the userbots that FAILED to join this target. Idempotent: bots that
 * are already members are re-checked and settle as success. Also pulls in any
 * logged-in userbots that were added after the task started but never queued.
 */
export async function retryChannelJoin(targetId: number) {
  await requireAuth()
  const target = await queryOne<ChannelJoinTarget>(`SELECT * FROM channel_join_targets WHERE id = $1`, [targetId])
  if (!target) return { error: "Join task not found." }

  // Failed participants to retry + logged-in accounts not yet in this task.
  const retryFailed = await query<{ account_id: number }>(
    `SELECT account_id FROM channel_join_participants WHERE target_id = $1 AND status = 'failed'`,
    [targetId],
  )
  const missing = await query<{ id: number }>(
    `SELECT a.id FROM telegram_accounts a
      WHERE a.status = 'logged_in'
        AND NOT EXISTS (
          SELECT 1 FROM channel_join_participants p
          WHERE p.target_id = $1 AND p.account_id = a.id
        )`,
    [targetId],
  )

  const accountIds = [...retryFailed.map((r) => r.account_id), ...missing.map((r) => r.id)]
  if (accountIds.length === 0) return { error: "No failed or missing userbots to retry." }

  await query(`UPDATE channel_join_targets SET status = 'joining', last_error = NULL, updated_at = now() WHERE id = $1`, [
    targetId,
  ])
  await enqueueJoinBatch(targetId, target.chat_link, accountIds)
  await recount(targetId)

  revalidatePath("/")
  return { ok: true, count: accountIds.length }
}

/** Delete a channel-join task and drop any of its still-queued join jobs. */
export async function deleteChannelJoin(targetId: number) {
  await requireAuth()
  // Stop the worker from processing joins for a task we are deleting.
  await query(
    `DELETE FROM jobs
      WHERE type = 'join_channel'
        AND status = 'queued'
        AND (payload->>'target_id')::int = $1`,
    [targetId],
  )
  await query(`DELETE FROM channel_join_participants WHERE target_id = $1`, [targetId])
  await query(`DELETE FROM channel_join_targets WHERE id = $1`, [targetId])
  revalidatePath("/")
  return { ok: true }
}
