// Shared input validation/sanitization helpers used across the dashboard forms.
// Two goals:
//   1. Link fields accept ONLY Telegram links (nothing else can be submitted).
//   2. "How many userbots" style fields can never exceed the userbots available.

// Remove every whitespace character. Telegram links never contain spaces, so we
// strip them as the user types/pastes to keep the field link-only.
export function stripSpaces(value: string): string {
  return value.replace(/\s+/g, "")
}

// True only for a well-formed Telegram link / handle. Accepts:
//   @username
//   username            (bare public username)
//   t.me/username       (+ optional /123 message id, trailing slash)
//   t.me/+invitehash    and  t.me/joinchat/hash
//   telegram.me/...     and  https:// / http:// / www. prefixes
export function isTelegramLink(raw: string): boolean {
  const s = stripSpaces(raw)
  if (!s) return false

  // @username or bare public username (5-32 chars, letters/digits/underscore).
  if (/^@?[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(s)) return true

  const noProto = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "")
  // t.me / telegram.me public, invite (+hash / joinchat/hash) and post links.
  if (/^(t|telegram)\.me\/(\+[a-zA-Z0-9_-]+|joinchat\/[a-zA-Z0-9_-]+|[a-zA-Z0-9_]{3,32}(\/[0-9]+)?)\/?$/i.test(noProto)) {
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
