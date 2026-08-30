import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import type { FrozenAccountRow } from "@/lib/types"

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Every account Telegram has frozen, with the freeze reason (last_error) and
  // the latest appeal attempt state so the Appeal tab can show progress.
  const accounts = await query<FrozenAccountRow>(
    `SELECT
       id,
       label,
       phone_number,
       status,
       last_error    AS frozen_reason,
       appeal_status,
       appeal_result,
       appeal_at,
       updated_at
     FROM telegram_accounts
     WHERE status = 'frozen'
     ORDER BY updated_at DESC`,
  )

  return NextResponse.json({ accounts })
}
