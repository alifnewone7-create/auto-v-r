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
import { Vote, Trash2, Loader2, Link2, AlertCircle, RefreshCw, Plus, Minus, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"
import { castVotes, removeVotes, detectPoll, redetectPoll, deleteVoteTarget } from "@/app/actions/vote"
import type { VoteOptionTally, VoteTargetRow } from "@/lib/types"

const STATUS_STYLES: Record<string, string> = {
  detecting: "bg-chart-4/20 text-chart-4 border-transparent",
  ready: "bg-chart-3/20 text-chart-3 border-transparent",
  failed: "bg-destructive/15 text-destructive border-transparent",
}

function OptionRow({
  target,
  tally,
  disabled,
  onChanged,
}: {
  target: VoteTargetRow
  tally: VoteOptionTally
  disabled: boolean
  onChanged: () => void
}) {
  const [amount, setAmount] = useState(1)
  const [pending, startTransition] = useTransition()
  const available = target.available_accounts

  function doVote() {
    const n = Math.max(1, Math.min(amount, available))
    startTransition(async () => {
      const res = await castVotes(target.id, tally.index, n)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      const got = res?.count ?? 0
      const want = res?.requested ?? n
      toast.success(got < want ? `Voted with ${got} bot(s) — that's all that were free.` : `Dispatched ${got} vote(s).`)
      onChanged()
    })
  }

  function doRemove() {
    const n = Math.max(1, Math.min(amount, tally.total))
    startTransition(async () => {
      const res = await removeVotes(target.id, tally.index, n)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success(`Removing ${res?.count ?? n} vote(s).`)
      onChanged()
    })
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium leading-snug text-pretty">{tally.text}</p>
        <div className="flex shrink-0 items-center gap-1.5 text-xs">
          {tally.voted > 0 ? (
            <span className="flex items-center gap-1 rounded-md bg-chart-3/15 px-1.5 py-0.5 text-chart-3">
              <CheckCircle2 className="size-3" />
              {tally.voted}
            </span>
          ) : null}
          {tally.pending > 0 ? (
            <span className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {tally.pending}
            </span>
          ) : null}
          {tally.failed > 0 ? (
            <span className="rounded-md bg-destructive/15 px-1.5 py-0.5 text-destructive">{tally.failed} failed</span>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
          className="h-8 w-20"
          aria-label={`Number of votes for ${tally.text}`}
          disabled={disabled || pending}
        />
        <Button
          size="sm"
          className="h-8 gap-1"
          onClick={doVote}
          disabled={disabled || pending || available < 1}
          title={available < 1 ? "No free userbots left for this poll" : undefined}
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          Vote
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 bg-transparent"
          onClick={doRemove}
          disabled={disabled || pending || tally.total < 1}
          title={tally.total < 1 ? "No votes to remove on this option" : undefined}
        >
          <Minus className="size-3.5" />
          Remove
        </Button>
      </div>
    </div>
  )
}

export function VoteSection() {
  const { data, mutate } = useSWR<{ targets: VoteTargetRow[]; userbots: number }>("/api/vote-targets", fetcher, {
    refreshInterval: 3000,
  })
  const [pending, startTransition] = useTransition()
  const targets = data?.targets ?? []
  const userbots = data?.userbots ?? 0

  function handleDetect(formData: FormData) {
    startTransition(async () => {
      const res = await detectPoll(formData)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success("Detecting poll… options will appear shortly.")
      ;(document.getElementById("vote-form") as HTMLFormElement | null)?.reset()
      mutate()
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Vote className="size-4 text-primary" />
            Vote on a poll
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form id="vote-form" action={handleDetect} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="poll_link">Poll / channel link</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="poll_link"
                    name="poll_link"
                    placeholder="t.me/channel/123, @channel or t.me/+invite"
                    className="pl-9"
                    required
                  />
                </div>
                <Button type="submit" disabled={pending} className="gap-2">
                  {pending ? <Loader2 className="size-4 animate-spin" /> : <Vote className="size-4" />}
                  Detect poll
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {`Paste a public or private channel link. The most recent poll is detected and shown below. You have ${userbots} logged-in userbot${userbots === 1 ? "" : "s"} to vote with.`}
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      {targets.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Vote className="size-6" />
          </div>
          <div>
            <p className="font-medium">No polls yet</p>
            <p className="text-sm text-muted-foreground">Paste a channel link above to detect its latest poll.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {targets.map((t) => (
            <Card key={t.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div className="min-w-0">
                  <CardTitle className="truncate text-sm font-medium">{t.question || t.poll_link}</CardTitle>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{t.poll_link}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Badge className={STATUS_STYLES[t.status] ?? STATUS_STYLES.detecting}>{t.status}</Badge>
                  {t.status === "failed" ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground"
                      title="Retry detection"
                      onClick={() =>
                        startTransition(async () => {
                          await redetectPoll(t.id)
                          mutate()
                        })
                      }
                    >
                      <RefreshCw className="size-4" />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    title="Remove poll"
                    onClick={() =>
                      startTransition(async () => {
                        await deleteVoteTarget(t.id)
                        mutate()
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <Separator className="mb-3" />

                {t.status === "detecting" ? (
                  <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Detecting the latest poll in this channel…
                  </div>
                ) : t.status === "failed" ? (
                  <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                    <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="break-words">{t.last_error || "Could not detect a poll in this channel."}</span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span className="text-muted-foreground">
                        {`Free userbots: `}
                        <span className="font-medium tabular-nums text-foreground">{t.available_accounts}</span>
                        {` / ${userbots}`}
                      </span>
                      <span className="text-muted-foreground">
                        {`Already voted: `}
                        <span className="font-medium tabular-nums text-foreground">{t.used_accounts}</span>
                      </span>
                      {t.multiple_choice ? <span className="text-muted-foreground">multiple choice</span> : null}
                    </div>

                    {t.tallies.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No options found in this poll.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {t.tallies.map((tally) => (
                          <OptionRow
                            key={tally.index}
                            target={t}
                            tally={tally}
                            disabled={pending}
                            onChanged={mutate}
                          />
                        ))}
                      </div>
                    )}

                    {t.available_accounts < 1 ? (
                      <p className="text-xs text-muted-foreground">
                        Every userbot has voted on this poll. Remove some votes to free them up.
                      </p>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
