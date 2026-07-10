"use server"

import { query, queryOne } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"
import { isTelegramLink } from "@/lib/validation"
import type { ViewTarget } from "@/lib/types"

async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized")
}

/**
 * Add a channel to the Live View watch list. The Python agent picks it up,
 * sets a future-only baseline, then auto-views every NEW post with all
 * logged-in userbots.
 */
export async function addViewTarget(formData: FormData) {
  await requireAuth()
  const link = String(formData.get("channel_link") ?? "").trim()
  if (!link) return { error: "Channel link is required." }
  if (!isTelegramLink(link)) return { error: "Enter a valid Telegram link." }

  const existing = await queryOne<ViewTarget>(`SELECT * FROM view_targets WHERE channel_link = $1`, [link])
  if (existing) return { error: "That channel is already being watched." }

  await query(
    `INSERT INTO view_targets (channel_link, status, last_seen_message_id)
     VALUES ($1, 'active', 0)`,
    [link],
  )

  revalidatePath("/")
  return { ok: true }
}

/** Pause or resume auto-viewing for a channel. */
export async function toggleViewTarget(targetId: number, status: "active" | "paused") {
  await requireAuth()
  await query(`UPDATE view_targets SET status = $1, updated_at = now() WHERE id = $2`, [status, targetId])
  revalidatePath("/")
  return { ok: true }
}

/** Stop watching a channel and remove it. */
export async function removeViewTarget(targetId: number) {
  await requireAuth()
  await query(`DELETE FROM view_targets WHERE id = $1`, [targetId])
  revalidatePath("/")
  return { ok: true }
}
