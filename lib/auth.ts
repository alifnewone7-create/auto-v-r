import "server-only"
import { cookies } from "next/headers"
import crypto from "crypto"

// Lightweight single-admin gate. The whole panel controls Telegram accounts and
// session strings, so it must never be public. We don't need multi-user auth
// here, just a 3-factor credential gate backed by an httpOnly cookie.
//
// Login requires all three of ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_SECRET
// (all set in Vercel Project Settings > Vars). The cookie value is an HMAC
// derived from all three, so it cannot be forged without knowing them, and it
// auto-invalidates if any of them change. Raw credentials are never stored or
// sent to the client.

const COOKIE_NAME = "tg_admin_session"

function adminCreds(): { username: string; password: string; secret: string } {
  const username = process.env.ADMIN_USERNAME
  const password = process.env.ADMIN_PASSWORD
  const secret = process.env.ADMIN_SECRET
  if (!username || !password || !secret) {
    throw new Error(
      "ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_SECRET must all be set. Add them in Project Settings > Vars.",
    )
  }
  return { username, password, secret }
}

function expectedToken(): string {
  const { username, password, secret } = adminCreds()
  // Bind the session to all three credentials at once.
  return crypto
    .createHmac("sha256", `${password}:${secret}`)
    .update(`tg-userbot-admin:${username}`)
    .digest("hex")
}

// Constant-time string compare that never throws on length mismatch.
function safeEqual(input: string, expected: string): boolean {
  const a = Buffer.from(input)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function verifyCredentials(username: string, password: string, secret: string): boolean {
  const expectedUser = process.env.ADMIN_USERNAME
  const expectedPass = process.env.ADMIN_PASSWORD
  const expectedSecret = process.env.ADMIN_SECRET
  if (!expectedUser || !expectedPass || !expectedSecret) return false
  // Evaluate all three so timing doesn't leak which field was wrong.
  const okUser = safeEqual(username, expectedUser)
  const okPass = safeEqual(password, expectedPass)
  const okSecret = safeEqual(secret, expectedSecret)
  return okUser && okPass && okSecret
}

export async function createSession() {
  const store = await cookies()
  store.set(COOKIE_NAME, expectedToken(), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  })
}

export async function destroySession() {
  const store = await cookies()
  store.delete(COOKIE_NAME)
}

export async function isAuthenticated(): Promise<boolean> {
  try {
    const store = await cookies()
    const token = store.get(COOKIE_NAME)?.value
    if (!token) return false
    const expected = expectedToken()
    const a = Buffer.from(token)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}
