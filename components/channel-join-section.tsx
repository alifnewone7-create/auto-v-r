"use client"

import { useState, useTransition } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  UserPlus,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  Link2,
  Users,
  AlertCircle,
  RefreshCw,
} from "lucide-react"
import { toast } from "sonner"
import { joinChannel, retryChannelJoin, deleteChannelJoin } from "@/app/actions/channel-join"
import type { ChannelJoinTargetRow } from "@/lib/types"

const STATUS_STYLES: Record<string, string> = {
  joining: "bg-chart-4/20 text-chart-4 border-transparent",
  done: "bg-chart-3/20 text-chart-3 border-transparent",
  partial: "bg-chart-4/20 text-chart-4 border-transparent",
  failed: "bg-destructive/15 text-destructive border-transparent",
}

const JOINED_STATUSES = ["joined", "already_member"]

function TargetCard({ target, onChanged }: { target: ChannelJoinTargetRow; onChanged: () => void }) {
  const [pending, startTransition] = useTransition()
  const participants = target.participants
  const joined = participants.filter((p) => JOINED_STATUSES.includes(p.status)).length
  const failed = participants.filter((p) => p.status === "failed").length
  const inProgress = participants.filter((p) => p.status === "pending" || p.status === "joining").length

  function run(
    fn: () => Promise<{ error?: string; count?: number; ok?: boolean } | void>,
    success: (n: number) => string,
  ) {
    startTransition(async () => {
      const res = await fn()
      if (res && "error" in res && res.error) {
        toast.error(res.error)
        return
      }
      toast.success(success(res && "count" in res ? (res.count ?? 0) : 0))
      onChanged()
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate text-sm font-medium">{target.title || target.chat_link}</CardTitle>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="size-3.5" />
            <span className="font-medium tabular-nums text-foreground">{joined}</span>
            {` of ${target.total_count} joined`}
            {failed > 0 ? ` · ${failed} failed` : ""}
            {inProgress > 0 ? ` · ${inProgress} in progress` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Badge className={STATUS_STYLES[target.status] ?? STATUS_STYLES.joining}>{target.status}</Badge>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            title="Retry failed / missing userbots"
            disabled={pending || (failed === 0 && target.status === "done")}
            onClick={() =>
              run(
                () => retryChannelJoin(target.id),
                (n) => `Retrying ${n} userbot${n === 1 ? "" : "s"}.`,
              )
            }
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            title="Delete this join task"
            disabled={pending}
            onClick={() => run(() => deleteChannelJoin(target.id), () => "Join task deleted.")}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {target.last_error ? (
          <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{target.last_error}</span>
          </div>
        ) : null}

        <Separator />
        <div className="flex flex-wrap gap-2">
          {participants.length === 0 ? (
            <p className="text-xs text-muted-foreground">No userbots in this task.</p>
          ) : (
            participants.map((p) => (
              <div
                key={p.account_id}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
                title={p.last_error || (p.status === "already_member" ? "Already a member" : undefined)}
              >
                {JOINED_STATUSES.includes(p.status) ? (
                  <CheckCircle2 className="size-3.5 text-chart-3" />
                ) : p.status === "failed" ? (
                  <XCircle className="size-3.5 text-destructive" />
                ) : (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                )}
                <span className="text-muted-foreground">{p.label || p.phone}</span>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function ChannelJoinSection() {
  const { data, mutate } = useSWR<{ targets: ChannelJoinTargetRow[]; logged_in_count: number }>(
    "/api/channel-join",
    fetcher,
    { refreshInterval: 3000 },
  )
  const [pending, startTransition] = useTransition()
  const targets = data?.targets ?? []
  const loggedInCount = data?.logged_in_count ?? 0

  function handleJoin(formData: FormData) {
    startTransition(async () => {
      const res = await joinChannel(formData)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success(`Dispatched join to ${res?.count} of ${res?.available} userbot${res?.available === 1 ? "" : "s"}.`)
      mutate()
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="size-4 text-primary" />
            Join a channel / group
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form action={handleJoin} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="cj_chat_link">Channel / group link</Label>
              <div className="relative">
                <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="cj_chat_link"
                  name="chat_link"
                  placeholder="@channel, t.me/link or t.me/+invite"
                  className="pl-9"
                  required
                />
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-2 sm:w-48">
                <Label htmlFor="cj_count">How many userbots</Label>
                <Input
                  id="cj_count"
                  name="count"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  placeholder="All logged-in bots"
                />
              </div>
              <Button type="submit" disabled={pending} className="gap-2 sm:ml-auto">
                {pending ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                Join with userbots
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {`Public or private link. Every selected userbot joins the chat (leave the count blank to use all ${loggedInCount}). Getting them in first makes future reactions, views and votes work reliably. Already-joined bots are counted as done, and expired / wrong links are skipped per-bot without any crash.`}
            </p>
          </form>
        </CardContent>
      </Card>

      {targets.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserPlus className="size-6" />
          </div>
          <div>
            <p className="font-medium">No channel joins yet</p>
            <p className="text-sm text-muted-foreground">Paste a link above to get your userbots into a chat.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {targets.map((t) => (
            <TargetCard key={t.id} target={t} onChanged={mutate} />
          ))}
        </div>
      )}
    </div>
  )
}
