import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import type { PollOption, VoteOptionTally, VoteTarget, VoteTargetRow } from "@/lib/types"

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const targets = await query<VoteTarget>(`SELECT * FROM vote_targets ORDER BY created_at DESC`)

  // All casts across all targets, so we can compute per-option tallies.
  const casts = await query<{ target_id: number; option_index: number; status: string }>(
    `SELECT target_id, option_index, status FROM vote_casts`,
  )

  // Total logged-in userbots (the ceiling on how many can vote per poll).
  const userbotsRow = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM telegram_accounts WHERE status = 'logged_in'`,
  )
  const userbots = userbotsRow[0]?.count ?? 0

  const rows: VoteTargetRow[] = targets.map((t) => {
    const options: PollOption[] = Array.isArray(t.options) ? t.options : []
    const myCasts = casts.filter((c) => c.target_id === t.id)

    const tallies: VoteOptionTally[] = options.map((opt) => {
      const forOpt = myCasts.filter((c) => c.option_index === opt.index)
      const pending = forOpt.filter((c) => c.status === "pending").length
      const voted = forOpt.filter((c) => c.status === "voted").length
      const removing = forOpt.filter((c) => c.status === "removing").length
      const failed = forOpt.filter((c) => c.status === "failed").length
      return {
        index: opt.index,
        text: opt.text,
        pending: pending + removing,
        voted,
        failed,
        total: pending + voted + removing,
      }
    })

    // An account is "used" if it has any non-failed cast on this poll.
    const used = myCasts.filter((c) => c.status !== "failed").length

    return {
      ...t,
      options,
      tallies,
      used_accounts: used,
      available_accounts: Math.max(userbots - used, 0),
    }
  })

  return NextResponse.json({ targets: rows, userbots })
}
