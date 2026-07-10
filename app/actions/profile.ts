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
  // A pool of data URLs ("data:image/jpeg;base64,....") for the new profile
  // photos. When more than one is supplied, each selected account is assigned a
  // RANDOM photo from the pool. Empty/omitted leaves the photo unchanged.
  //
  // NOTE: Prefer `photoAssetIds` (pre-uploaded one-by-one via uploadProfilePhoto)
  // for multi-image edits. Sending many data URLs here in a single call can
  // exceed the Server Action body limit and crash the request. This field is
  // kept only for the single-image / backward-compatible path.
  photoDataUrls?: string[]
  // Asset IDs of photos already uploaded via `uploadProfilePhoto` (one request
  // each). This is the crash-safe path for multiple images: the heavy base64
  // payloads are streamed up one at a time, and only the small integer IDs are
  // sent here. When both are provided, these are appended to `photoDataUrls`.
  photoAssetIds?: number[]
  // Distribution mode for the name / photo pools:
  //  - false (default, "cycle"): every selected account is changed; the pool is
  //    shuffled and cycled, so a 2-name pool applied to 300 accounts repeats
  //    across all 300.
  //  - true ("no repeat"): each name / photo is used AT MOST ONCE. Only the
  //    first max(names, photos) accounts change; the rest are skipped. So a
  //    2-name + 2-photo pool over 300 accounts changes exactly 2 accounts.
  noRepeat?: boolean
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

// Validate a base64 image data URL and persist it as its own profile_assets row.
// Returns the new asset id, or an { error } message on bad input. Shared by the
// single-call path (updateProfiles) and the one-at-a-time uploader below.
async function storePhotoDataUrl(dataUrl: string): Promise<{ id: number } | { error: string }> {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return { error: "Invalid image. Please choose JPEG or PNG files." }
  const mime = match[1]
  const b64 = match[2]
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(mime)) {
    return { error: "Photos must be JPEG, PNG, or WebP images." }
  }
  const approxBytes = Math.floor((b64.length * 3) / 4)
  if (approxBytes > MAX_PHOTO_BYTES) {
    return { error: "One of the photos is too large. Please use images under 5MB." }
  }
  const asset = await queryOne<{ id: number }>(
    `INSERT INTO profile_assets (data, mime) VALUES ($1, $2) RETURNING id`,
    [b64, mime],
  )
  return { id: asset!.id }
}

/**
 * Upload ONE profile photo and return its asset id. The client calls this once
 * per selected image (sequentially) before calling `updateProfiles`, so each
 * heavy base64 payload travels in its own small request. This is what keeps a
 * multi-image edit from exceeding the Server Action body limit and throwing the
 * "this page couldn't load" error.
 */
export async function uploadProfilePhoto(dataUrl: string) {
  await requireAuth()
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return { error: "No image provided." }
  }
  return storePhotoDataUrl(dataUrl)
}

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
  const photoDataUrls = (input.photoDataUrls ?? []).filter((u) => typeof u === "string" && u.length > 0)
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

  // Photos already uploaded one-by-one via `uploadProfilePhoto` arrive here as
  // small integer ids - this is the crash-safe path for multiple images.
  const preUploadedIds = (input.photoAssetIds ?? []).filter((n) => Number.isInteger(n))

  if (
    !useNamePool &&
    !firstName &&
    !lastName &&
    !baseUsername &&
    photoDataUrls.length === 0 &&
    preUploadedIds.length === 0
  ) {
    return { error: "Enter a name, a name list, a username, or choose a photo to change." }
  }

  // Start from the pre-uploaded asset ids, then store any inline data URLs
  // (single-image / backward-compatible path) as their own assets. When several
  // photos are supplied we assign one at random per account below (like names).
  const photoAssetIds: number[] = [...preUploadedIds]
  for (const dataUrl of photoDataUrls) {
    const stored = await storePhotoDataUrl(dataUrl)
    if ("error" in stored) return { error: stored.error }
    photoAssetIds.push(stored.id)
  }
  const usesPhotoPool = photoAssetIds.length > 0

  // Only touch accounts that are actually logged in.
  const accounts = await query<{ id: number }>(
    `SELECT id FROM telegram_accounts WHERE status = 'logged_in' AND id = ANY($1::int[]) ORDER BY id`,
    [ids],
  )
  if (accounts.length === 0) {
    return { error: "None of the selected accounts are logged in." }
  }

  const noRepeat = Boolean(input.noRepeat)

  // Decide, per account, which name / photo it receives.
  //
  // Two distribution modes:
  //  - Cycle (default): shuffle the pool(s) and hand a RANDOM entry to EVERY
  //    selected account, reshuffling when a bag empties. A 2-name pool applied
  //    to 300 accounts changes all 300 (names repeat).
  //  - No-repeat: each name / photo is used AT MOST ONCE. Only the first
  //    max(names, photos) accounts are changed; the rest are skipped entirely.
  //    So 3 names + 2 photos changes 3 accounts (acc1: name+photo, acc2:
  //    name+photo, acc3: name only), and every other selected account is left
  //    untouched. Accounts beyond a given pool just skip that field (null),
  //    which the Python agent treats as "leave unchanged" - never an error.
  type Assignment = { first: string | null; last: string | null; photoAssetId: number | null }
  let assignments: Assignment[]
  let targetAccounts = accounts

  if (noRepeat && (useNamePool || usesPhotoPool)) {
    const shuffledNames = shuffle(namePool)
    const shuffledPhotos = shuffle(photoAssetIds)
    const limit = Math.min(accounts.length, Math.max(shuffledNames.length, shuffledPhotos.length))
    targetAccounts = accounts.slice(0, limit)
    assignments = targetAccounts.map((_, i) => {
      const picked = useNamePool && i < shuffledNames.length ? shuffledNames[i] : null
      return {
        // In name-pool mode, accounts past the pool get no name change (null).
        // In single-name mode, the manual name still applies to each target.
        first: picked ? picked.first : useNamePool ? null : firstName || null,
        last: picked ? picked.last || null : useNamePool ? null : lastName || null,
        photoAssetId: usesPhotoPool && i < shuffledPhotos.length ? shuffledPhotos[i] : null,
      }
    })
  } else {
    // Cycle mode: shuffle-and-cycle so the distribution stays random and even.
    let bag: { first: string; last: string }[] = []
    const nextName = () => {
      if (bag.length === 0) bag = shuffle(namePool)
      return bag.pop()!
    }
    let photoBag: number[] = []
    const nextPhotoAssetId = (): number | null => {
      if (!usesPhotoPool) return null
      if (photoBag.length === 0) photoBag = shuffle(photoAssetIds)
      return photoBag.pop()!
    }
    assignments = accounts.map(() => {
      if (useNamePool) {
        const picked = nextName()
        return { first: picked.first, last: picked.last || null, photoAssetId: nextPhotoAssetId() }
      }
      return { first: firstName || null, last: lastName || null, photoAssetId: nextPhotoAssetId() }
    })
  }

  // Queue one profile_updates row + one update_profile job per TARGET account.
  await Promise.all(
    targetAccounts.map((acc, idx) => {
      const assign = assignments[idx]
      const accFirst = assign.first
      const accLast = assign.last
      let username: string | null = null
      let usernameBase: string | null = null

      if (autoUsername) {
        // Seed the username from the (assigned) name; the agent finalizes it.
        const seedName = [accFirst, accLast].filter(Boolean).join(" ")
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
        photoAssetId: assign.photoAssetId,
      })
    }),
  )

  revalidatePath("/")
  return { ok: true, count: targetAccounts.length }
}

/**
 * Queue a "delete all profile photos" job for each selected, logged-in account.
 * The Python agent removes the current photo AND every older one from history.
 * Accounts with no photo are handled gracefully (reported as 0 deleted, never an
 * error), and a failure only fails the job - it never logs the userbot out.
 */
export async function deleteProfilePhotos(input: { accountIds: number[] }) {
  await requireAuth()

  const ids = Array.from(new Set((input.accountIds ?? []).filter((n) => Number.isInteger(n))))
  if (ids.length === 0) return { error: "Select at least one account." }

  const accounts = await query<{ id: number }>(
    `SELECT id FROM telegram_accounts WHERE status = 'logged_in' AND id = ANY($1::int[]) ORDER BY id`,
    [ids],
  )
  if (accounts.length === 0) {
    return { error: "None of the selected accounts are logged in." }
  }

  await Promise.all(
    accounts.map(async (acc) => {
      // A profile_updates row so the UI can show per-account progress, reusing the
      // same status pipeline as name/photo edits.
      const row = await queryOne<{ id: number }>(
        `INSERT INTO profile_updates (account_id, status) VALUES ($1, 'pending') RETURNING id`,
        [acc.id],
      )
      await query(
        `INSERT INTO jobs (type, account_id, payload, status) VALUES ('delete_profile_photos', $1, $2::jsonb, 'queued')`,
        [acc.id, JSON.stringify({ profile_update_id: row!.id })],
      )
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
