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
  // A newline-separated pool of full names ("Rahim Hasan", "Afiya Noor", …).
  // When provided, each selected account is assigned a RANDOM name from the
  // pool instead of using firstName/lastName. A line with a single word sets
  // only the first name (no last name).
  names?: string[]
  // When true, each account's username is auto-generated from its assigned name
  // (e.g. "Rahim Hasan" -> "rahimhasan" + random digits). The Python agent keeps
  // trying new random suffixes until it finds one that isn't already taken.
  autoUsername?: boolean
  // A data URL ("data:image/jpeg;base64,....") for the new profile photo, or
  // empty/omitted to leave the photo unchanged.
  photoDataUrl?: string
}

// "Rahim Hasan" -> { first: "Rahim", last: "Hasan" }; "Afiya" -> { first: "Afiya", last: "" }
function parseName(line: string): { first: string; last: string } {
  const parts = line.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: "", last: "" }
  const first = parts[0]
  const last = parts.slice(1).join(" ")
  return { first, last }
}

// Turn a display name into a valid username seed: ascii letters/numbers only,
// lowercase, must start with a letter. The agent appends random digits to reach
// the 5-char minimum and to resolve collisions, so this can be short here.
function slugifyName(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  const trimmed = ascii.replace(/^[^a-z]+/, "") // usernames must start with a letter
  return trimmed.slice(0, 24)
}

// Fisher-Yates shuffle (returns a new array).
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
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
  const autoUsername = Boolean(input.autoUsername)

  // Clean up the name pool: drop blank lines, keep only lines with a usable name.
  const namePool = (input.names ?? [])
    .map((n) => n.trim())
    .filter(Boolean)
    .map(parseName)
    .filter((n) => n.first)
  const useNamePool = namePool.length > 0

  if (baseUsername && !/^[a-zA-Z0-9_]{5,32}$/.test(baseUsername)) {
    return {
      error: "Username must be 5-32 characters: letters, numbers or underscores only.",
    }
  }

  if (!useNamePool && !firstName && !lastName && !baseUsername && !photoDataUrl) {
    return { error: "Enter a name, a name list, a username, or choose a photo to change." }
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

  // Build a randomized name assignment: shuffle the pool and hand out names.
  // When there are more accounts than names, we reshuffle and keep cycling so
  // the distribution stays random rather than repeating in order.
  let bag: { first: string; last: string }[] = []
  const nextName = () => {
    if (bag.length === 0) bag = shuffle(namePool)
    return bag.pop()!
  }

  // Queue one profile_updates row + one update_profile job per account.
  await Promise.all(
    accounts.map((acc, idx) => {
      let accFirst = firstName || null
      let accLast = lastName || null
      let username: string | null = null
      let usernameBase: string | null = null

      if (useNamePool) {
        const picked = nextName()
        accFirst = picked.first
        accLast = picked.last || null // no last name -> stays empty
      }

      if (autoUsername) {
        // Seed the username from the (assigned) name; the agent finalizes it.
        const seedName = useNamePool
          ? [accFirst, accLast].filter(Boolean).join(" ")
          : [firstName, lastName].filter(Boolean).join(" ")
        usernameBase = slugifyName(seedName) || null
      } else if (baseUsername) {
        // Manual username: give each account a distinct suffix when applying to many.
        username = idx === 0 ? baseUsername : `${baseUsername}${idx}`
      }

      return enqueueForAccount(acc.id, {
        firstName: accFirst,
        lastName: accLast,
        username,
        usernameBase,
        autoUsername,
        photoAssetId,
      })
    }),
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
    usernameBase: string | null
    autoUsername: boolean
    photoAssetId: number | null
  },
) {
  // We store the final username if we already know it; for auto-generated ones we
  // store the base as a placeholder so the row reflects roughly what was applied.
  const displayUsername = fields.username ?? fields.usernameBase

  const row = await queryOne<{ id: number }>(
    `INSERT INTO profile_updates (account_id, first_name, last_name, username, photo_asset_id, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [accountId, fields.firstName, fields.lastName, displayUsername, fields.photoAssetId],
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
        username_base: fields.usernameBase,
        auto_username: fields.autoUsername,
        photo_asset_id: fields.photoAssetId,
      }),
    ],
  )
}
