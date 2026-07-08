"use server"

import { query, queryOne } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"
import type { LivestreamTarget, TelegramAccount } from "@/lib/types"

// A livestream target is "running" while it is joining, active, or in the
// middle of leaving. Only one running task is allowed at a time.
const RUNNING_STATUSES = ["joining", "active", "leaving"] as const
// Participant statuses that count as "occupying" a slot in the stream.
const ACTIVE_PARTICIPANT_STATUSES = ["pending", "joining", "joined", "leaving"] as const

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

// Cancel every still-queued join_livestream job for a target. Called when a task
// is stopped/deleted so the worker stops pulling more bots INTO a stream that is
// being torn down (otherwise queued joins keep running "in the backend").
async function cancelQueuedJoinJobs(targetId: number) {
  await query(
    `DELETE FROM jobs
      WHERE type = 'join_livestream'
        AND status = 'queued'
        AND (payload->>'target_id')::int = $1`,
    [targetId],
  )
}

// Recomputes total_count from the live participant set so the card always shows
// how many userbots are actually in (or heading into) the stream.
async function syncTotalCount(targetId: number) {
  await query(
    `UPDATE livestream_targets t
        SET total_count = (
              SELECT count(*) FROM livestream_participants p
              WHERE p.target_id = t.id AND p.status = ANY($2)
            ),
            updated_at = now()
      WHERE t.id = $1`,
    [targetId, ACTIVE_PARTICIPANT_STATUSES],
  )
}

/**
 * Join a live stream / video chat. Creates a target, then queues one
 * `join_livestream` job per logged-in userbot so they all join in parallel.
 * The Python agent makes each userbot join the chat and then its active group
 * call in listen-only mode.
 *
 * Only ONE live stream task may run at a time — if another is already running
 * (joining / active / leaving) this is rejected so tasks can't overlap.
 */
export async function joinLivestream(formData: FormData) {
  await requireAuth()

  // Single-task lock: refuse to start a new stream while one is still running.
  const running = await queryOne<LivestreamTarget>(
    `SELECT * FROM livestream_targets WHERE status = ANY($1) ORDER BY created_at DESC LIMIT 1`,
    [RUNNING_STATUSES],
  )
  if (running) {
    return {
      error: "A live stream task is already running. Stop or delete it before starting another.",
    }
  }

  const link = String(formData.get("chat_link") ?? "").trim()
  if (!link) return { error: "Channel / group link is required." }

  // How many userbots to send in. Blank / 0 / "all" -> use every logged-in bot.
  const rawCount = String(formData.get("count") ?? "").trim()
  const requested = rawCount === "" ? 0 : Number.parseInt(rawCount, 10)
  if (rawCount !== "" && (!Number.isFinite(requested) || requested < 0)) {
    return { error: "Enter a valid number of userbots (or leave blank for all)." }
  }

  const allAccounts = await query<TelegramAccount>(
    // Random order so repeated joins spread across different accounts, and so a
    // partial count doesn't always pick the same bots.
    `SELECT * FROM telegram_accounts WHERE status = 'logged_in' ORDER BY random()`,
  )
  if (allAccounts.length === 0) return { error: "No logged-in userbots available. Add and log in an account first." }

  // Cap the request to what's actually available; 0/blank means "all".
  const take = requested > 0 ? Math.min(requested, allAccounts.length) : allAccounts.length
  const accounts = allAccounts.slice(0, take)

  const target = await queryOne<LivestreamTarget>(
    `INSERT INTO livestream_targets (chat_link, status, total_count, joined_count)
     VALUES ($1, 'joining', $2, 0) RETURNING *`,
    [link, accounts.length],
  )

  // Bulk-insert participants + join jobs in TWO round-trips (not two per bot).
  // Looping one INSERT per account meant ~2000 sequential queries for a
  // 1000-bot task, which is slow and can time out the server action before all
  // jobs are queued. UNNEST fans the whole batch out in a single statement.
  const accountIds = accounts.map((a) => a.id)
  await enqueueJoinBatch(target!.id, link, accountIds)

  revalidatePath("/")
  return { ok: true, count: accounts.length, available: allAccounts.length }
}

// Queue join jobs for a whole batch of accounts at once: one INSERT for all the
// participant rows and one INSERT for all the join_livestream jobs. Keeps
// starting/scaling a 500-1000 bot stream fast and within serverless limits.
async function enqueueJoinBatch(targetId: number, chatLink: string, accountIds: number[]) {
  if (accountIds.length === 0) return
  await query(
    `INSERT INTO livestream_participants (target_id, account_id, status)
     SELECT $1, uid, 'pending' FROM unnest($2::int[]) AS uid
     ON CONFLICT (target_id, account_id) DO UPDATE SET status = 'pending', last_error = NULL`,
    [targetId, accountIds],
  )
  await query(
    `INSERT INTO jobs (type, account_id, payload, status)
     SELECT 'join_livestream', uid,
            jsonb_build_object('target_id', $1::int, 'chat_link', $2::text), 'queued'
     FROM unnest($3::int[]) AS uid`,
    [targetId, chatLink, accountIds],
  )
}

/**
 * Add MORE userbots to an already-running live stream. Picks logged-in bots that
 * aren't already in this stream, queues join jobs for them and grows the count.
 */
export async function addLivestreamBots(targetId: number, count: number) {
  await requireAuth()
  if (!Number.isFinite(count) || count < 1) return { error: "Enter how many userbots to add." }

  const target = await queryOne<LivestreamTarget>(`SELECT * FROM livestream_targets WHERE id = $1`, [targetId])
  if (!target) return { error: "Live stream not found." }

  // Logged-in accounts not currently occupying a slot in this stream.
  const available = await query<TelegramAccount>(
    `SELECT a.* FROM telegram_accounts a
      WHERE a.status = 'logged_in'
        AND NOT EXISTS (
          SELECT 1 FROM livestream_participants p
          WHERE p.target_id = $1 AND p.account_id = a.id AND p.status = ANY($2)
        )
      ORDER BY random()`,
    [targetId, ACTIVE_PARTICIPANT_STATUSES],
  )
  if (available.length === 0) return { error: "No more free userbots to add." }

  const take = Math.min(count, available.length)
  const accounts = available.slice(0, take)

  await enqueueJoinBatch(targetId, target.chat_link, accounts.map((a) => a.id))

  // Adding bots reactivates a stopped/failed stream.
  await query(
    `UPDATE livestream_targets
        SET status = CASE WHEN status IN ('stopped', 'failed', 'idle') THEN 'joining' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [targetId],
  )
  await syncTotalCount(targetId)

  revalidatePath("/")
  return { ok: true, count: accounts.length, available: available.length }
}

/**
 * Make a specific NUMBER of currently-joined userbots leave the stream. Picks
 * that many joined participants and queues a leave job for each.
 */
export async function removeLivestreamBots(targetId: number, count: number) {
  await requireAuth()
  if (!Number.isFinite(count) || count < 1) return { error: "Enter how many userbots to remove." }

  const target = await queryOne<LivestreamTarget>(`SELECT * FROM livestream_targets WHERE id = $1`, [targetId])
  if (!target) return { error: "Live stream not found." }

  const joined = await query<{ account_id: number }>(
    `SELECT account_id FROM livestream_participants
      WHERE target_id = $1 AND status = 'joined'
      ORDER BY random() LIMIT $2`,
    [targetId, count],
  )
  if (joined.length === 0) return { error: "No joined userbots to remove." }

  const accountIds = joined.map((p) => p.account_id)
  await query(
    `UPDATE livestream_participants SET status = 'leaving', updated_at = now()
      WHERE target_id = $1 AND account_id = ANY($2)`,
    [targetId, accountIds],
  )
  // One bulk job leaves all selected bots concurrently (fast even for hundreds).
  await enqueueJob("leave_livestream_all", null, {
    target_id: targetId,
    chat_link: target.chat_link,
    account_ids: accountIds,
  })

  revalidatePath("/")
  return { ok: true, count: joined.length }
}

/** Make ALL userbots leave a live stream target. */
export async function leaveLivestream(targetId: number) {
  await requireAuth()
  const target = await queryOne<LivestreamTarget>(`SELECT * FROM livestream_targets WHERE id = $1`, [targetId])
  if (!target) return { error: "Live stream not found." }

  // Stop the worker from joining any more bots into this stream.
  await cancelQueuedJoinJobs(targetId)

  const participants = await query<{ account_id: number }>(
    `SELECT account_id FROM livestream_participants WHERE target_id = $1 AND status = 'joined'`,
    [targetId],
  )
  await query(`UPDATE livestream_targets SET status = 'leaving', updated_at = now() WHERE id = $1`, [targetId])
  await query(
    `UPDATE livestream_participants SET status = 'leaving', updated_at = now()
      WHERE target_id = $1 AND status = 'joined'`,
    [targetId],
  )
  // Single bulk job so every bot leaves concurrently in seconds.
  await enqueueJob("leave_livestream_all", null, {
    target_id: targetId,
    chat_link: target.chat_link,
    account_ids: participants.map((p) => p.account_id),
  })
  revalidatePath("/")
  return { ok: true }
}

/**
 * INSTANTLY stop a running live stream task without deleting it.
 *
 * The moment this is called the target flips to `stopped` (a non-running status),
 * so the single-task lock is released immediately and a new task can be started
 * within a second — no waiting for hundreds of bots to physically leave. All the
 * userbots still in the stream are dropped by ONE bulk `leave_livestream_all`
 * job that the agent runs concurrently, so they exit within a minute or two.
 * The task row is kept so you can add bots to it again later.
 */
export async function stopLivestream(targetId: number) {
  await requireAuth()
  const target = await queryOne<LivestreamTarget>(`SELECT * FROM livestream_targets WHERE id = $1`, [targetId])
  if (!target) return { error: "Live stream not found." }

  // Drop any queued joins first so the worker stops feeding bots into the stream.
  await cancelQueuedJoinJobs(targetId)

  const participants = await query<{ account_id: number }>(
    `SELECT account_id FROM livestream_participants
      WHERE target_id = $1 AND status = ANY($2)`,
    [targetId, ACTIVE_PARTICIPANT_STATUSES],
  )
  const accountIds = participants.map((p) => p.account_id)

  // Flip to stopped right away — releases the single-task lock instantly.
  await query(`UPDATE livestream_targets SET status = 'stopped', updated_at = now() WHERE id = $1`, [targetId])
  await query(
    `UPDATE livestream_participants SET status = 'leaving', updated_at = now()
      WHERE target_id = $1 AND status = ANY($2)`,
    [targetId, ACTIVE_PARTICIPANT_STATUSES],
  )

  if (accountIds.length > 0) {
    await enqueueJob("leave_livestream_all", null, {
      target_id: targetId,
      chat_link: target.chat_link,
      account_ids: accountIds,
    })
  }

  revalidatePath("/")
  return { ok: true, count: accountIds.length }
}

/**
 * Delete a live stream task. This is INSTANT on the website: we snapshot the
 * accounts still in the stream, enqueue ONE bulk `leave_livestream_all` job
 * carrying every account_id + the chat_link, then immediately delete the target
 * and its participant rows. Because the leave job carries its own account list
 * and chat_link, it does not depend on the (now-deleted) target row.
 *
 * The agent runs all the leaves concurrently, so even a 500-1000 bot stream is
 * fully torn down within a minute or two of pressing delete.
 */
export async function deleteLivestream(targetId: number) {
  await requireAuth()
  const target = await queryOne<LivestreamTarget>(`SELECT * FROM livestream_targets WHERE id = $1`, [targetId])

  // Kill queued joins so the worker can't keep pulling bots into a task we are
  // about to delete.
  await cancelQueuedJoinJobs(targetId)

  const participants = await query<{ account_id: number }>(
    `SELECT account_id FROM livestream_participants
      WHERE target_id = $1 AND status = ANY($2)`,
    [targetId, ACTIVE_PARTICIPANT_STATUSES],
  )

  const accountIds = participants.map((p) => p.account_id)
  if (accountIds.length > 0) {
    // Single bulk leave job: instant to enqueue, processed concurrently so all
    // bots drop out fast. target_id is omitted on purpose since the row is about
    // to be deleted (the job only needs account_ids + chat_link to leave).
    await enqueueJob("leave_livestream_all", null, {
      chat_link: target?.chat_link ?? "",
      account_ids: accountIds,
    })
  }

  await query(`DELETE FROM livestream_participants WHERE target_id = $1`, [targetId])
  await query(`DELETE FROM livestream_targets WHERE id = $1`, [targetId])
  revalidatePath("/")
  return { ok: true }
}
