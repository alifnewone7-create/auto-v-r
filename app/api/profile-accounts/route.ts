import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import type { ProfileAccountRow } from "@/lib/types"

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Each account with its MOST RECENT profile update (if any), so the UI can
  // show per-account progress (pending / done / failed) after a bulk edit.
  const accounts = await query<ProfileAccountRow>(
    `SELECT
       a.id,
       a.label,
       a.phone_number,
       a.status,
       pu.status     AS profile_status,
       pu.last_error AS profile_error,
       pu.updated_at AS profile_updated_at
     FROM telegram_accounts a
     LEFT JOIN LATERAL (
       SELECT status, last_error, updated_at
       FROM profile_updates
       WHERE account_id = a.id
       ORDER BY id DESC
       LIMIT 1
     ) pu ON true
     WHERE a.status = 'logged_in'
     ORDER BY a.created_at DESC`,
  )

  return NextResponse.json({ accounts })
}
