import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Every logged-in account becomes a numbered slot 1..N in the composer.
  const accounts = await query<{ id: number; label: string | null; phone_number: string }>(
    `SELECT id, label, phone_number
       FROM telegram_accounts
      WHERE status = 'logged_in'
      ORDER BY id`,
  )

  // Recent campaigns with their per-account send rows.
  const campaigns = await query(
    `SELECT c.*,
       COALESCE(json_agg(
         json_build_object(
           'id', s.id,
           'account_id', s.account_id,
           'position', s.position,
           'phone', a.phone_number,
           'label', a.label,
           'steps', s.steps,
           'status', s.status,
           'last_error', s.last_error
         ) ORDER BY s.position
       ) FILTER (WHERE s.id IS NOT NULL), '[]') AS sends
     FROM message_campaigns c
     LEFT JOIN message_sends s ON s.campaign_id = c.id
     LEFT JOIN telegram_accounts a ON a.id = s.account_id
     GROUP BY c.id
     ORDER BY c.created_at DESC
     LIMIT 30`,
  )

  return NextResponse.json({ accounts, campaigns })
}
