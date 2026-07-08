import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"

// Recent Telegram messages for one account. We only ever return the last 30
// minutes: matches the agent's 30-minute auto-purge so the box shows a short,
// rolling window of fresh system notices (login codes, etc.) and nothing old.
export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const accountId = Number(searchParams.get("account_id"))
  if (!Number.isInteger(accountId) || accountId < 1) {
    return NextResponse.json({ error: "Invalid account_id" }, { status: 400 })
  }

  const messages = await query(
    `SELECT id, sender, body, telegram_message_id, message_date, created_at
       FROM account_messages
      WHERE account_id = $1
        AND created_at > now() - interval '30 minutes'
      ORDER BY created_at DESC
      LIMIT 100`,
    [accountId],
  )

  return NextResponse.json({ messages })
}
