"use server"

import { query, queryOne, LIVE_BUSY_STATUSES, notInLiveSql } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"
import type { MessageStep } from "@/lib/types"

async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized")
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5MB per image
const MAX_VIDEO_BYTES = 20 * 1024 * 1024 // 20MB per video (base64 in DB — keep modest)

/**
 * Upload ONE media file (image or video) and return its asset id. The client
 * calls this once per file (sequentially) before sending the campaign, so each
 * heavy base64 payload travels in its own small request — this is what keeps a
 * multi-file upload from exceeding the Server Action body limit.
 */
export async function uploadMessageAsset(dataUrl: string) {
  await requireAuth()
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return { error: "No file provided." }
  }
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return { error: "Invalid file. Please choose an image or video." }
  const mime = match[1]
  const b64 = match[2]

  let kind: "image" | "video"
  if (/^image\/(jpeg|jpg|png|webp|gif)$/i.test(mime)) kind = "image"
  else if (/^video\/(mp4|quicktime|webm|x-matroska)$/i.test(mime)) kind = "video"
  else return { error: "Only JPEG/PNG/WebP images or MP4/WebM/MOV videos are allowed." }

  const approxBytes = Math.floor((b64.length * 3) / 4)
  const cap = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
  if (approxBytes > cap) {
    return {
      error:
        kind === "video"
          ? "That video is too large. Please use videos under 20MB."
          : "That image is too large. Please use images under 5MB.",
    }
  }

  const asset = await queryOne<{ id: number }>(
    `INSERT INTO message_assets (data, mime, kind) VALUES ($1, $2, $3) RETURNING id`,
    [b64, mime, kind],
  )
  return { id: asset!.id, kind }
}

export interface SendCampaignInput {
  targetLink: string
  // One entry per numbered slot the user filled. accountId must be a logged-in
  // account. `steps` is the ordered sequence that account will send.
  accounts: { accountId: number; steps: MessageStep[] }[]
}

// Keep only well-formed steps with real content, preserving order.
function sanitizeSteps(steps: MessageStep[]): MessageStep[] {
  const out: MessageStep[] = []
  for (const step of steps ?? []) {
    if (!step || typeof step !== "object") continue
    if (step.kind === "text") {
      const text = String(step.text ?? "").trim()
      if (text) out.push({ kind: "text", text })
    } else if (step.kind === "album" || step.kind === "video") {
      const ids = (step.asset_ids ?? []).filter((n) => Number.isInteger(n))
      if (ids.length > 0) out.push({ kind: step.kind, asset_ids: ids })
    }
  }
  return out
}

/**
 * Create a DM campaign: for every filled numbered slot we queue one `send_dm`
 * job (a paced job type, so the accounts message the target one-by-one with a
 * gap). Each account sends its own ordered steps. The Python agent resolves the
 * target user, sends every step, and writes progress back to message_sends.
 */
export async function sendMessageCampaign(input: SendCampaignInput) {
  await requireAuth()

  const targetLink = String(input?.targetLink ?? "").trim()
  if (!targetLink) return { error: "Enter the target user's Telegram link or @username." }

  // Validate + trim each slot's steps.
  const slots = (input?.accounts ?? [])
    .map((a) => ({ accountId: Number(a.accountId), steps: sanitizeSteps(a.steps) }))
    .filter((a) => Number.isInteger(a.accountId) && a.steps.length > 0)

  if (slots.length === 0) {
    return { error: "Add at least one message (text or media) for at least one account." }
  }

  // Only allow logged-in accounts that are NOT currently reserved for a live
  // stream, and confirm every referenced asset exists. An account in a live call
  // takes no other work, so it's skipped here (it becomes usable again the moment
  // it leaves the stream) rather than fighting the live keep-alive.
  const accountIds = Array.from(new Set(slots.map((s) => s.accountId)))
  const eligible = await query<{ id: number }>(
    `SELECT a.id FROM telegram_accounts a
      WHERE a.status = 'logged_in'
        AND a.id = ANY($1::int[])
        AND ${notInLiveSql("a", 2)}`,
    [accountIds, LIVE_BUSY_STATUSES],
  )
  const eligibleSet = new Set(eligible.map((a) => a.id))
  const usableSlots = slots.filter((s) => eligibleSet.has(s.accountId))
  const skippedLive = slots.length - usableSlots.length
  if (usableSlots.length === 0) {
    return {
      error:
        skippedLive > 0
          ? "All selected accounts are busy in a live stream right now. Try again after they leave the live."
          : "None of the selected accounts are logged in.",
    }
  }

  // Create the campaign row first so sends/jobs can reference it.
  const campaign = await queryOne<{ id: number }>(
    `INSERT INTO message_campaigns (target_link, total_count, status)
     VALUES ($1, $2, 'sending') RETURNING id`,
    [targetLink, usableSlots.length],
  )
  const campaignId = campaign!.id

  // One message_sends row + one paced send_dm job per account.
  await Promise.all(
    usableSlots.map(async (slot, idx) => {
      const row = await queryOne<{ id: number }>(
        `INSERT INTO message_sends (campaign_id, account_id, position, steps, status)
         VALUES ($1, $2, $3, $4::jsonb, 'pending') RETURNING id`,
        [campaignId, slot.accountId, idx + 1, JSON.stringify(slot.steps)],
      )
      await query(
        `INSERT INTO jobs (type, account_id, payload, status) VALUES ('send_dm', $1, $2::jsonb, 'queued')`,
        [slot.accountId, JSON.stringify({ campaign_id: campaignId, send_id: row!.id })],
      )
    }),
  )

  revalidatePath("/")
  return { ok: true, count: usableSlots.length, skippedLive }
}

export async function deleteMessageCampaign(campaignId: number) {
  await requireAuth()
  const id = Number(campaignId)
  if (!Number.isInteger(id)) return { error: "Invalid campaign." }
  // Cancel any still-queued jobs for this campaign, then delete the campaign
  // (message_sends cascade). Jobs already claimed/processing are left to finish.
  await query(
    `DELETE FROM jobs
      WHERE type = 'send_dm' AND status = 'queued'
        AND (payload->>'campaign_id')::int = $1`,
    [id],
  )
  await query(`DELETE FROM message_campaigns WHERE id = $1`, [id])
  revalidatePath("/")
  return { ok: true }
}
