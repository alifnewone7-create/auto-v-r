"use server"

import { query, queryOne, LIVE_BUSY_STATUSES, notInLiveSql } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"
import { isTelegramLink } from "@/lib/validation"
import type { TelegramAccount, VoteTarget } from "@/lib/types"

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
 * Step 1 — paste a poll link. We create a vote_target in `detecting` state and
 * queue a `detect_poll` job. The Python agent opens the channel, reads the most
 * recent poll, and fills in question / options / poll_id / chat_id / message_id,
 * then flips the status to `ready`.
 */
export async function detectPoll(formData: FormData) {
  await requireAuth()
  const link = String(formData.get("poll_link") ?? "").trim()
  if (!link) return { error: "Poll / channel link is required." }
  if (!isTelegramLink(link)) return { error: "Enter a valid Telegram link." }

  const accounts = await query<TelegramAccount>(`SELECT id FROM telegram_accounts WHERE status = 'logged_in' LIMIT 1`)
  if (accounts.length === 0) {
    return { error: "No logged-in userbots available. Add and log in an account first." }
  }

  const target = await queryOne<VoteTarget>(
    `INSERT INTO vote_targets (poll_link, status) VALUES ($1, 'detecting') RETURNING *`,
    [link],
  )

  // Detection itself only needs one userbot to read the poll.
  await enqueueJob("detect_poll", accounts[0].id, { target_id: target!.id, poll_link: link })

  revalidatePath("/")
  return { ok: true }
}

/** Re-run detection for a target (e.g. after it failed). */
export async function redetectPoll(targetId: number) {
  await requireAuth()
  const target = await queryOne<VoteTarget>(`SELECT * FROM vote_targets WHERE id = $1`, [targetId])
  if (!target) return { error: "Poll not found." }

  const account = await queryOne<TelegramAccount>(`SELECT id FROM telegram_accounts WHERE status = 'logged_in' LIMIT 1`)
  if (!account) return { error: "No logged-in userbots available." }

  await query(`UPDATE vote_targets SET status = 'detecting', last_error = NULL, updated_at = now() WHERE id = $1`, [
    targetId,
  ])
  await enqueueJob("detect_poll", account.id, { target_id: targetId, poll_link: target.poll_link })

  revalidatePath("/")
  return { ok: true }
}

/**
 * Step 2 — cast `amount` votes on `optionIndex`. Only userbots that have NOT
 * already voted on this poll are eligible (each account votes once per poll).
 * We pick up to `amount` free accounts, reserve a `vote_casts` row for each,
 * and queue a `cast_vote` job. Already-used accounts are skipped automatically.
 */
export async function castVotes(targetId: number, optionIndex: number, amount: number) {
  await requireAuth()
  if (!Number.isInteger(amount) || amount < 1) return { error: "Enter a valid number of votes." }

  const target = await queryOne<VoteTarget>(`SELECT * FROM vote_targets WHERE id = $1`, [targetId])
  if (!target) return { error: "Poll not found." }
  if (target.status !== "ready") return { error: "Poll is not ready yet. Detect the poll first." }

  // Logged-in userbots with NO active cast on this poll = the ones still free.
  // Accounts currently reserved for a live stream are excluded (they take no
  // other work until they leave); with fewer free accounts we simply cast fewer
  // votes (capped by LIMIT) — never an error, never a crash.
  const free = await query<TelegramAccount>(
    `SELECT a.id FROM telegram_accounts a
     WHERE a.status = 'logged_in'
       AND NOT EXISTS (
         SELECT 1 FROM vote_casts c
         WHERE c.target_id = $1 AND c.account_id = a.id AND c.status <> 'failed'
       )
       AND ${notInLiveSql("a", 3)}
     ORDER BY a.id
     LIMIT $2`,
    [targetId, amount, LIVE_BUSY_STATUSES],
  )

  if (free.length === 0) {
    return { error: "No free userbots left for this poll. Every account has already voted." }
  }

  for (const acc of free) {
    await query(
      `INSERT INTO vote_casts (target_id, account_id, option_index, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (target_id, account_id)
       DO UPDATE SET option_index = $3, status = 'pending', last_error = NULL, updated_at = now()`,
      [targetId, acc.id, optionIndex],
    )
    await enqueueJob("cast_vote", acc.id, {
      target_id: targetId,
      chat_id: target.chat_id,
      message_id: target.message_id,
      poll_id: target.poll_id,
      poll_link: target.poll_link,
      option_index: optionIndex,
    })
  }

  revalidatePath("/")
  return { ok: true, count: free.length, requested: amount }
}

/**
 * Step 3 — remove up to `amount` of OUR votes from `optionIndex`. We pick the
 * most recent active casts on that option, mark them `removing`, and queue a
 * `retract_vote` job. Once the agent confirms removal it deletes the row, which
 * frees that account to vote again on this poll.
 */
export async function removeVotes(targetId: number, optionIndex: number, amount: number) {
  await requireAuth()
  if (!Number.isInteger(amount) || amount < 1) return { error: "Enter a valid number of votes to remove." }

  const target = await queryOne<VoteTarget>(`SELECT * FROM vote_targets WHERE id = $1`, [targetId])
  if (!target) return { error: "Poll not found." }

  const casts = await query<{ id: number; account_id: number }>(
    `SELECT id, account_id FROM vote_casts
     WHERE target_id = $1 AND option_index = $2 AND status IN ('voted', 'pending')
     ORDER BY updated_at DESC
     LIMIT $3`,
    [targetId, optionIndex, amount],
  )

  if (casts.length === 0) return { error: "No removable votes on this option." }

  for (const c of casts) {
    await query(`UPDATE vote_casts SET status = 'removing', last_error = NULL, updated_at = now() WHERE id = $1`, [c.id])
    await enqueueJob("retract_vote", c.account_id, {
      target_id: targetId,
      cast_id: c.id,
      chat_id: target.chat_id,
      message_id: target.message_id,
      poll_id: target.poll_id,
      poll_link: target.poll_link,
      option_index: optionIndex,
    })
  }

  revalidatePath("/")
  return { ok: true, count: casts.length }
}

/** Remove the whole poll target and all of its casts. */
export async function deleteVoteTarget(targetId: number) {
  await requireAuth()
  await query(`DELETE FROM vote_casts WHERE target_id = $1`, [targetId])
  await query(`DELETE FROM vote_targets WHERE id = $1`, [targetId])
  revalidatePath("/")
  return { ok: true }
}
