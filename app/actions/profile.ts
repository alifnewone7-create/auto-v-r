"use server"

import { query, queryOne } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"

async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized")
}

export interface ProfileEditInput {
  accountIds: number[]
  firstName?: string
  lastName?: string
  username?: string
  // A data URL ("data:image/jpeg;base64,....") for the new profile photo, or
  // empty/omitted to leave the photo unchanged.
  photoDataUrl?: string
}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024 // 5MB cap on the uploaded image

/**
 * Bulk profile edit. For every selected account we queue an `update_profile`
 * job. The Python agent picks each up, changes the account's name / username /
 * photo, and writes the result back to the matching `profile_updates` row.
 *
 * Username handling: Telegram usernames are globally unique, so only ONE account
 * can hold a given @username. If a username is provided and more than one account
 * is selected, we auto-suffix (name, name1, name2, …) so every account gets a
 * distinct, valid username instead of all-but-one failing with "username taken".
 */
export async function updateProfiles(input: ProfileEditInput) {
  await requireAuth()

  const ids = Array.from(new Set((input.accountIds ?? []).filter((n) => Number.isInteger(n))))
  if (ids.length === 0) return { error: "Select at least one account." }

  const firstName = (input.firstName ?? "").trim()
  const lastName = (input.lastName ?? "").trim()
  const baseUsername = (input.username ?? "").trim().replace(/^@/, "")
  const photoDataUrl = input.photoDataUrl ?? ""

  if (baseUsername && !/^[a-zA-Z0-9_]{5,32}$/.test(baseUsername)) {
    return {
      error: "Username must be 5-32 characters: letters, numbers or underscores only.",
    }
  }

  if (!firstName && !lastName && !baseUsername && !photoDataUrl) {
    return { error: "Enter a name, username, or choose a photo to change." }
  }

  // Store the uploaded photo once and reuse the asset id across every account.
  let photoAssetId: number | null = null
  if (photoDataUrl) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(photoDataUrl)
    if (!match) return { error: "Invalid image. Please choose a JPEG or PNG file." }
    const mime = match[1]
    const b64 = match[2]
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(mime)) {
      return { error: "Photo must be a JPEG, PNG, or WebP image." }
    }
    const approxBytes = Math.floor((b64.length * 3) / 4)
    if (approxBytes > MAX_PHOTO_BYTES) {
      return { error: "Photo is too large. Please use an image under 5MB." }
    }
    const asset = await queryOne<{ id: number }>(
      `INSERT INTO profile_assets (data, mime) VALUES ($1, $2) RETURNING id`,
      [b64, mime],
    )
    photoAssetId = asset!.id
  }

  // Only touch accounts that are actually logged in.
  const accounts = await query<{ id: number }>(
    `SELECT id FROM telegram_accounts WHERE status = 'logged_in' AND id = ANY($1::int[]) ORDER BY id`,
    [ids],
  )
  if (accounts.length === 0) {
    return { error: "None of the selected accounts are logged in." }
  }

  // Queue one profile_updates row + one update_profile job per account.
  await Promise.all(
    accounts.map((acc, idx) =>
      enqueueForAccount(acc.id, {
        firstName: firstName || null,
        lastName: lastName || null,
        // Give each account a distinct username when one is requested for many.
        username: baseUsername ? (idx === 0 ? baseUsername : `${baseUsername}${idx}`) : null,
        photoAssetId,
      }),
    ),
  )

  revalidatePath("/")
  return { ok: true, count: accounts.length }
}

async function enqueueForAccount(
  accountId: number,
  fields: {
    firstName: string | null
    lastName: string | null
    username: string | null
    photoAssetId: number | null
  },
) {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO profile_updates (account_id, first_name, last_name, username, photo_asset_id, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [accountId, fields.firstName, fields.lastName, fields.username, fields.photoAssetId],
  )

  await query(
    `INSERT INTO jobs (type, account_id, payload, status) VALUES ('update_profile', $1, $2::jsonb, 'queued')`,
    [
      accountId,
      JSON.stringify({
        profile_update_id: row!.id,
        first_name: fields.firstName,
        last_name: fields.lastName,
        username: fields.username,
        photo_asset_id: fields.photoAssetId,
      }),
    ],
  )
}
