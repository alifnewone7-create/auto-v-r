import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  // An agent is "online" if it sent a heartbeat in the last 30 seconds.
  const agents = await query(
    `SELECT id, hostname, active_accounts, note, last_seen,
            (last_seen > now() - interval '30 seconds') AS online
     FROM agents ORDER BY last_seen DESC`,
  )
  const queued = await query<{ count: string }>(`SELECT count(*)::int AS count FROM jobs WHERE status = 'queued'`)
  const processing = await query<{ count: string }>(
    `SELECT count(*)::int AS count FROM jobs WHERE status = 'processing'`,
  )
  return NextResponse.json({
    agents,
    queued: queued[0]?.count ?? 0,
    processing: processing[0]?.count ?? 0,
  })
}
