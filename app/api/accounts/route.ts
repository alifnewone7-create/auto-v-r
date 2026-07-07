import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const accounts = await query(
    `SELECT id, label, phone_number, app_title, short_name, api_id, api_hash,
            (session_string IS NOT NULL) AS has_session, status, two_factor_required,
            last_error, source, country_code, two_step_password,
            provision_step, provision_code, created_at, updated_at
     FROM telegram_accounts ORDER BY created_at DESC`,
  )
  return NextResponse.json({ accounts })
}
