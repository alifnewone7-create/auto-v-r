import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const targets = await query(
    `SELECT t.*,
       COALESCE(json_agg(
         json_build_object(
           'account_id', p.account_id,
           'phone', a.phone_number,
           'label', a.label,
           'status', p.status,
           'last_error', p.last_error
         ) ORDER BY p.id
       ) FILTER (WHERE p.id IS NOT NULL), '[]') AS participants
     FROM livestream_targets t
     LEFT JOIN livestream_participants p ON p.target_id = t.id
     LEFT JOIN telegram_accounts a ON a.id = p.account_id
     GROUP BY t.id
     ORDER BY t.created_at DESC`,
  )
  const [{ count }] = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM telegram_accounts WHERE status = 'logged_in'`,
  )
  return NextResponse.json({ targets, logged_in_count: count })
}
