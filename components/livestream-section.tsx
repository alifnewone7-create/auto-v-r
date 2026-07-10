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
import { Radio, LogOut, Trash2, Loader2, CheckCircle2, XCircle, Link2, Plus, Minus, Users, AlertCircle, Square, Hand } from "lucide-react"
import { toast } from "sonner"
import {
  joinLivestream,
  leaveLivestream,
  stopLivestream,
  deleteLivestream,
  addLivestreamBots,
  removeLivestreamBots,
  raiseHandLivestream,
} from "@/app/actions/livestream"
import type { LivestreamTarget } from "@/lib/types"
import { isTelegramLink, stripSpaces, clampCount } from "@/lib/validation"

interface Participant {
  account_id: number
  phone: string
  label: string | null
  status: string
  last_error: string | null
}
type TargetRow = LivestreamTarget & { participants: Participant[] }

const STATUS_STYLES: Record<string, string> = {
  joining: "bg-chart-4/20 text-chart-4 border-transparent",
  active: "bg-chart-3/20 text-chart-3 border-transparent",
  leaving: "bg-chart-4/20 text-chart-4 border-transparent",
  stopped: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive border-transparent",
  idle: "bg-muted text-muted-foreground",
}

const RUNNING_STATUSES = ["joining", "active", "leaving"]
const ACTIVE_PARTICIPANT_STATUSES = ["pending", "joining", "joined", "leaving"]

function TargetCard({
  target,
  loggedInCount,
  onChanged,
}: {
  target: TargetRow
  loggedInCount: number
  onChanged: () => void
}) {
  // Kept as strings so the fields can be CLEARED while typing (an empty box)
  // instead of snapping back to "1" on every keystroke. We parse + clamp only
  // when the action actually fires.
  const [addAmount, setAddAmount] = useState("1")
  const [removeAmount, setRemoveAmount] = useState("1")
  const [raiseAmount, setRaiseAmount] = useState("1")
  const [pending, startTransition] = useTransition()

  // Turn whatever is in a quantity box into a valid 1..max integer at submit time.
  const parseAmount = (raw: string, max: number) => clampCount(Number.parseInt(raw, 10) || 1, max)
  // Allow only digits while typing; "" stays "" so the box can be emptied.
  const onAmountChange = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setter(e.target.value.replace(/[^\d]/g, ""))

  const participants = target.participants
  const joinedCount = participants.filter((p) => p.status === "joined").length
  const inStreamCount = participants.filter((p) => ACTIVE_PARTICIPANT_STATUSES.includes(p.status)).length
  const availableToAdd = Math.max(0, loggedInCount - inStreamCount)

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
            <span className="font-medium tabular-nums text-foreground">{joinedCount}</span>
            {` live in stream · ${inStreamCount} sent`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Badge className={STATUS_STYLES[target.status] ?? STATUS_STYLES.idle}>{target.status}</Badge>
          {RUNNING_STATUSES.includes(target.status) ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-chart-4 hover:text-chart-4"
              title="Stop task now (turns off instantly, all userbots leave)"
              disabled={pending}
              onClick={() =>
                run(() => stopLivestream(target.id), (n) => `Task stopped — ${n} userbot${n === 1 ? "" : "s"} leaving.`)
              }
            >
              <Square className="size-4 fill-current" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            title="Make all userbots leave"
            disabled={pending || joinedCount < 1}
            onClick={() => run(() => leaveLivestream(target.id), () => "Leaving with all userbots.")}
          >
            <LogOut className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            title="Delete task (all userbots leave)"
            disabled={pending}
            onClick={() => run(() => deleteLivestream(target.id), () => "Task deleted — all userbots leaving.")}
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

        {/* Add / remove userbots by quantity */}
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <Input
              type="text"
              inputMode="numeric"
              value={addAmount}
              onChange={onAmountChange(setAddAmount)}
              onBlur={() => setAddAmount(String(parseAmount(addAmount, availableToAdd)))}
              className="h-8 w-20"
              aria-label="How many userbots to add"
              disabled={pending}
            />
            <Button
              size="sm"
              className="h-8 gap-1"
              disabled={pending || availableToAdd < 1}
              title={availableToAdd < 1 ? "No free userbots left to add" : undefined}
              onClick={() =>
                run(
                  () => addLivestreamBots(target.id, parseAmount(addAmount, availableToAdd)),
                  (n) => `Sending ${n} more userbot${n === 1 ? "" : "s"} in.`,
                )
              }
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Add bots
            </Button>
          </div>
          <div className="flex items-center gap-2 sm:ml-auto">
            <Input
              type="text"
              inputMode="numeric"
              value={removeAmount}
              onChange={onAmountChange(setRemoveAmount)}
              onBlur={() => setRemoveAmount(String(parseAmount(removeAmount, joinedCount)))}
              className="h-8 w-20"
              aria-label="How many userbots to remove"
              disabled={pending}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 bg-transparent"
              disabled={pending || joinedCount < 1}
              title={joinedCount < 1 ? "No joined userbots to remove" : undefined}
              onClick={() =>
                run(
                  () => removeLivestreamBots(target.id, parseAmount(removeAmount, joinedCount)),
                  (n) => `Removing ${n} userbot${n === 1 ? "" : "s"} from the stream.`,
                )
              }
            >
              <Minus className="size-3.5" />
              Remove bots
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {`${availableToAdd} free userbot${availableToAdd === 1 ? "" : "s"} left to add · ${loggedInCount} logged in total`}
        </p>

        {/* Raise / lower hand ("ask to speak") for a number of joined userbots */}
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <Hand className="size-4 shrink-0 text-primary" />
            <Input
              type="text"
              inputMode="numeric"
              value={raiseAmount}
              onChange={onAmountChange(setRaiseAmount)}
              onBlur={() => setRaiseAmount(String(parseAmount(raiseAmount, joinedCount)))}
              className="h-8 w-20"
              aria-label="How many userbots should raise their hand"
              disabled={pending}
            />
            <Button
              size="sm"
              className="h-8 gap-1"
              disabled={pending || joinedCount < 1}
              title={joinedCount < 1 ? "No joined userbots to raise a hand" : "Ask to speak (raise hand)"}
              onClick={() =>
                run(
                  () => raiseHandLivestream(target.id, parseAmount(raiseAmount, joinedCount), true),
                  (n) => `${n} userbot${n === 1 ? "" : "s"} raised their hand (asking to speak).`,
                )
              }
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Hand className="size-3.5" />}
              Raise hand
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 bg-transparent sm:ml-auto"
            disabled={pending || joinedCount < 1}
            title={joinedCount < 1 ? "No joined userbots" : "Lower hand for the same number of bots"}
            onClick={() =>
              run(
                () => raiseHandLivestream(target.id, parseAmount(raiseAmount, joinedCount), false),
                (n) => `${n} userbot${n === 1 ? "" : "s"} lowered their hand.`,
              )
            }
          >
            <Minus className="size-3.5" />
            Lower hand
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {`Ask to speak: pick how many of the ${joinedCount} joined userbot${
            joinedCount === 1 ? "" : "s"
          } should raise their hand in the live stream.`}
        </p>

        <Separator />
        <div className="flex flex-wrap gap-2">
          {participants.length === 0 ? (
            <p className="text-xs text-muted-foreground">No userbots in this stream.</p>
          ) : (
            participants.map((p) => (
              <div
                key={p.account_id}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
                title={p.last_error || undefined}
              >
                {p.status === "joined" ? (
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

export function LivestreamSection() {
  const { data, mutate } = useSWR<{ targets: TargetRow[]; logged_in_count: number }>("/api/livestream", fetcher, {
    refreshInterval: 3000,
  })
  const [pending, startTransition] = useTransition()
  const [link, setLink] = useState("")
  const targets = data?.targets ?? []
  const loggedInCount = data?.logged_in_count ?? 0

  // Only one live stream task may run at a time.
  const runningTask = targets.find((t) => RUNNING_STATUSES.includes(t.status))
  const locked = Boolean(runningTask)

  function handleJoin(formData: FormData) {
    const link = String(formData.get("chat_link") || "")
    if (!isTelegramLink(link)) {
      toast.error("Enter a valid Telegram link (@channel, t.me/link or t.me/+invite).")
      return
    }
    // Never dispatch more than the userbots we actually have.
    const raw = String(formData.get("count") || "").trim()
    if (raw) formData.set("count", String(clampCount(Number.parseInt(raw, 10) || 1, loggedInCount)))
    startTransition(async () => {
      const res = await joinLivestream(formData)
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
            <Radio className="size-4 text-primary" />
            Join a live stream
          </CardTitle>
        </CardHeader>
        <CardContent>
          {locked ? (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-chart-4" />
              <div>
                <p className="font-medium">A live stream task is already running</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {`Only one task can run at a time. Delete "${runningTask?.title || runningTask?.chat_link}" below to start a new one — or add/remove userbots on it directly.`}
                </p>
              </div>
            </div>
          ) : (
            <form action={handleJoin} className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="chat_link">Channel / group link</Label>
                <div className="relative">
                  <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="chat_link"
                    name="chat_link"
                    placeholder="@channel, t.me/link or t.me/+invite"
                    className="pl-9"
                    required
                    value={link}
                    onChange={(e) => {
                      const cleaned = stripSpaces(e.target.value)
                      setLink(cleaned)
                      e.target.value = cleaned
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex flex-col gap-2 sm:w-48">
                  <Label htmlFor="count">How many userbots</Label>
                  <Input
                    id="count"
                    name="count"
                    type="number"
                    min={1}
                    max={Math.max(1, loggedInCount)}
                    inputMode="numeric"
                    placeholder="All logged-in bots"
                    onInput={(e) => {
                      const digits = e.currentTarget.value.replace(/[^0-9]/g, "")
                      e.currentTarget.value =
                        digits === "" ? "" : String(clampCount(Number.parseInt(digits, 10), loggedInCount))
                    }}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={pending || !isTelegramLink(link)}
                  className="gap-2 sm:ml-auto"
                >
                  {pending ? <Loader2 className="size-4 animate-spin" /> : <Radio className="size-4" />}
                  Join live stream
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {`Public or private link. Enter how many userbots to send in (leave blank to use all ${loggedInCount}). They join the chat, then its active live stream in listen-only mode. You can add or remove more later.`}
              </p>
            </form>
          )}
        </CardContent>
      </Card>

      {targets.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Radio className="size-6" />
          </div>
          <div>
            <p className="font-medium">No live streams yet</p>
            <p className="text-sm text-muted-foreground">Paste a link above to send your userbots in.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {targets.map((t) => (
            <TargetCard key={t.id} target={t} loggedInCount={loggedInCount} onChanged={mutate} />
          ))}
        </div>
      )}
    </div>
  )
}
