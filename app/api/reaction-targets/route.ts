import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const targets = await query(`SELECT * FROM reaction_targets ORDER BY created_at DESC`)
  // Number of userbots that will react to each post (all logged-in accounts).
  const userbots = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM telegram_accounts WHERE status = 'logged_in'`,
  )
  return NextResponse.json({ targets, userbots: userbots[0]?.count ?? 0, max: 10 })
}
