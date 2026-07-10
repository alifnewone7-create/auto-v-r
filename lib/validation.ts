// Shared input validation/sanitization helpers used across the dashboard forms.
// Two goals:
//   1. Link fields accept ONLY Telegram links (nothing else can be submitted).
//   2. "How many userbots" style fields can never exceed the userbots available.

// Remove every whitespace character. Telegram links never contain spaces, so we
// strip them as the user types/pastes to keep the field link-only.
export function stripSpaces(value: string): string {
  return value.replace(/\s+/g, "")
}

// True ONLY for a real Telegram link / handle. To keep out arbitrary text, we
// require an explicit Telegram marker: either a leading "@" or a t.me /
// telegram.me domain. A bare word like "banana" is NOT accepted. Accepts:
//   @username                          (4-32 char handle: letters/digits/_)
//   t.me/username                      (+ optional /123 message id)
//   t.me/+invitehash    t.me/joinchat/hash
//   telegram.me/...   dog.tg/...       and https:// / http:// / www. prefixes
export function isTelegramLink(raw: string): boolean {
  const s = stripSpaces(raw)
  if (!s) return false

  // @username only (the "@" is what proves intent; bare words are rejected).
  if (/^@[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(s)) return true

  // Domain-based links: strip scheme + optional www., then require t.me /
  // telegram.me followed by a public username, invite hash, or post link.
  const noProto = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "")
  if (
    /^(t|telegram)\.me\/(\+[a-zA-Z0-9_-]+|joinchat\/[a-zA-Z0-9_-]+|[a-zA-Z][a-zA-Z0-9_]{3,31}(\/[0-9]+)?)\/?$/i.test(
      noProto,
    )
  ) {
    return true
  }
  return false
}

// Clamp a userbot-count to [min, max]. When `max` is 0 or negative (e.g. the
// available count hasn't loaded yet) the max cap is skipped so we never force
// the field to 0 prematurely.
export function clampCount(n: number, max: number, min = 1): number {
  const lower = Math.max(min, Number.isFinite(n) ? n : min)
  return max > 0 ? Math.min(lower, max) : lower
}
