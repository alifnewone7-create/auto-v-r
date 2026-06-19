import "server-only"
import { cookies } from "next/headers"
import crypto from "crypto"

// Lightweight single-admin gate. The whole panel controls Telegram accounts and
// session strings, so it must never be public. We don't need multi-user auth
// here, just a password gate backed by an httpOnly cookie.
//
// The cookie value is an HMAC derived from ADMIN_PASSWORD, so it cannot be
// forged without knowing the password, and it auto-invalidates if the password
// changes. The raw password is never stored or sent to the client.

const COOKIE_NAME = "tg_admin_session"

function adminPassword(): string {
  const pw = process.env.ADMIN_PASSWORD
  if (!pw) {
    throw new Error("ADMIN_PASSWORD is not set. Add it in Project Settings > Vars.")
  }
  return pw
}

function expectedToken(): string {
  return crypto.createHmac("sha256", adminPassword()).update("tg-userbot-admin").digest("hex")
}

export function verifyPassword(input: string): boolean {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected) return false
  // constant-time comparison
  const a = Buffer.from(input)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
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
