"use server"

import { query, queryOne } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"
import type { ReactionMode, ReactionTarget } from "@/lib/types"

async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized")
}

const MAX_TARGETS = 10
const VALID_MODES: ReactionMode[] = ["slow", "medium", "fast", "custom"]

/** Parse + validate the shared fields coming from the add/edit form. */
function parseFields(formData: FormData) {
  const link = String(formData.get("channel_link") ?? "").trim()

  // emojis arrive as a JSON array string from the client.
  let emojis: string[] = []
  try {
    const raw = JSON.parse(String(formData.get("emojis") ?? "[]"))
    if (Array.isArray(raw)) {
      emojis = raw.map((e) => String(e).trim()).filter(Boolean)
    }
  } catch {
    emojis = []
  }
  // De-duplicate while keeping order.
  emojis = Array.from(new Set(emojis))

  const mode = String(formData.get("mode") ?? "medium") as ReactionMode

  // custom_minutes = hours * 60 + minutes, with a hard floor of 1 minute.
  const hours = Number.parseInt(String(formData.get("custom_hours") ?? "0"), 10) || 0
  const minutes = Number.parseInt(String(formData.get("custom_minutes") ?? "0"), 10) || 0
  const customMinutes = Math.max(1, hours * 60 + minutes)

  return { link, emojis, mode, customMinutes }
}

function validate(fields: ReturnType<typeof parseFields>): string | null {
  if (!fields.link) return "Channel link is required."
  if (fields.emojis.length === 0) return "Pick at least one reaction emoji."
  if (!VALID_MODES.includes(fields.mode)) return "Invalid speed mode."
  if (fields.mode === "custom" && fields.customMinutes < 1) {
    return "Custom time must be at least 1 minute."
  }
  return null
}

/**
 * Add a channel to the auto-reaction list (max 10). The Python agent sets a
 * future-only baseline, then reacts to every NEW post using the chosen emojis,
 * spreading the reactions over a window based on the speed mode.
 */
export async function addReactionTarget(formData: FormData) {
  await requireAuth()
  const fields = parseFields(formData)
  const err = validate(fields)
  if (err) return { error: err }

  const count = await queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM reaction_targets`)
  if ((count?.count ?? 0) >= MAX_TARGETS) {
    return { error: `You can add a maximum of ${MAX_TARGETS} channels.` }
  }

  const existing = await queryOne<ReactionTarget>(`SELECT id FROM reaction_targets WHERE channel_link = $1`, [
    fields.link,
  ])
  if (existing) return { error: "That channel is already in the reaction list." }

  await query(
    `INSERT INTO reaction_targets (channel_link, emojis, mode, custom_minutes, status, last_seen_message_id)
     VALUES ($1, $2::jsonb, $3, $4, 'active', 0)`,
    [fields.link, JSON.stringify(fields.emojis), fields.mode, fields.customMinutes],
  )

  revalidatePath("/")
  return { ok: true }
}

/** Edit an existing target's emojis / mode / custom window. */
export async function updateReactionTarget(targetId: number, formData: FormData) {
  await requireAuth()
  const fields = parseFields(formData)
  // The link is not editable here, so ignore an empty link.
  if (fields.emojis.length === 0) return { error: "Pick at least one reaction emoji." }
  if (!VALID_MODES.includes(fields.mode)) return { error: "Invalid speed mode." }
  if (fields.mode === "custom" && fields.customMinutes < 1) {
    return { error: "Custom time must be at least 1 minute." }
  }

  await query(
    `UPDATE reaction_targets
     SET emojis = $1::jsonb, mode = $2, custom_minutes = $3, updated_at = now()
     WHERE id = $4`,
    [JSON.stringify(fields.emojis), fields.mode, fields.customMinutes, targetId],
  )

  revalidatePath("/")
  return { ok: true }
}

/** Pause or resume auto-reacting for a channel. */
export async function toggleReactionTarget(targetId: number, status: "active" | "paused") {
  await requireAuth()
  await query(`UPDATE reaction_targets SET status = $1, updated_at = now() WHERE id = $2`, [status, targetId])
  revalidatePath("/")
  return { ok: true }
}

/** Stop reacting on a channel and remove it. */
export async function removeReactionTarget(targetId: number) {
  await requireAuth()
  await query(`DELETE FROM reaction_targets WHERE id = $1`, [targetId])
  revalidatePath("/")
  return { ok: true }
}
