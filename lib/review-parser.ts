// Parser for the Review "bulk list" box. The panel lets you paste a numbered
// list where each number is an account (the 1st, 2nd, ... logged-in userbot),
// and every `#` line under it is an ADDITIONAL separate message that same
// account sends. Example input:
//
//   1. Great Work Bro
//   #nice bro thanks
//   2. to good bro nice
//   3. awesome sir
//   #you are cool
//   #just wow
//
// parses to:
//   { 1: ["Great Work Bro", "nice bro thanks"],
//     2: ["to good bro nice"],
//     3: ["awesome sir", "you are cool", "just wow"] }
//
// Rules:
//  - "N." (or "N)") starts account N; the text after it is that account's first
//    message.
//  - "#..." adds another separate message to the CURRENT account.
//  - A plain line (no marker) continues the previous message on a new line
//    (multi-line message), so paragraphs are preserved.
//  - Blank lines are ignored.

export type ParsedList = Record<number, string[]>

export function parseReviewList(raw: string): ParsedList {
  const result: ParsedList = {}
  const lines = (raw ?? "").split(/\r?\n/)

  let current: number | null = null

  const pushNewMessage = (acc: number, text: string) => {
    if (!result[acc]) result[acc] = []
    result[acc].push(text)
  }
  const appendToLast = (acc: number, text: string) => {
    const arr = result[acc]
    if (!arr || arr.length === 0) {
      pushNewMessage(acc, text)
      return
    }
    arr[arr.length - 1] = `${arr[arr.length - 1]}\n${text}`.trim()
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    // "1." / "12)" -> new account slot.
    const numMatch = /^(\d{1,3})[.)]\s?(.*)$/.exec(trimmed)
    if (numMatch) {
      current = Number.parseInt(numMatch[1], 10)
      const rest = numMatch[2].trim()
      if (!result[current]) result[current] = []
      if (rest) pushNewMessage(current, rest)
      continue
    }

    // "#..." -> additional separate message for the current account.
    if (trimmed.startsWith("#")) {
      if (current == null) continue
      const text = trimmed.slice(1).trim()
      if (text) pushNewMessage(current, text)
      continue
    }

    // Blank line: ignore.
    if (trimmed === "") continue

    // Plain continuation line: append to the current message (multi-line).
    if (current != null) appendToLast(current, trimmed)
  }

  // Drop empty message entries and accounts with nothing usable.
  for (const key of Object.keys(result)) {
    const k = Number(key)
    result[k] = result[k].map((t) => t.trim()).filter(Boolean)
    if (result[k].length === 0) delete result[k]
  }

  return result
}
