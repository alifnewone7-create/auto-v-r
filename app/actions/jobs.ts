"use server"

import { query } from "@/lib/db"
import { isAuthenticated } from "@/lib/auth"
import { revalidatePath } from "next/cache"

async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized")
}

/**
 * Kill every job currently stuck in the `processing` state.
 *
 * When an agent dies mid-batch the jobs it had claimed stay `processing`
 * forever (the claim query only ever picks up `queued` rows, so nothing
 * recovers them). This marks them all `failed` so the "running" counter clears
 * and the queue is unblocked. Returns how many were killed.
 */
export async function killProcessingJobs() {
  await requireAuth()
  const killed = await query<{ id: number }>(
    `UPDATE jobs
        SET status = 'failed',
            error = 'killed from dashboard',
            updated_at = now()
      WHERE status = 'processing'
      RETURNING id`,
  )
  revalidatePath("/")
  return { ok: true, count: killed.length }
}
