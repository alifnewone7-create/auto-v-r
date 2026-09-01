"use client"

import type React from "react"

import { useState, useTransition } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Snowflake,
  Loader2,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Clock,
  Send,
  ChevronDown,
} from "lucide-react"
import { toast } from "sonner"
import { appealAccounts, appealAllFrozen } from "@/app/actions/appeal"
import type { FrozenAccountRow, AppealStatus } from "@/lib/types"

const APPEAL_META: Record<
  AppealStatus,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  queued: { label: "Queued", className: "bg-chart-4/20 text-chart-4 border-transparent", icon: Clock },
  appealing: { label: "Appealing…", className: "bg-chart-1/20 text-chart-1 border-transparent", icon: Loader2 },
  submitted: { label: "Appeal sent", className: "bg-chart-3/20 text-chart-3 border-transparent", icon: Send },
  recovered: { label: "Recovered", className: "bg-chart-3/25 text-chart-3 border-transparent", icon: CheckCircle2 },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive border-transparent", icon: AlertCircle },
}

function timeAgo(iso: string | null): string {
  if (!iso) return ""
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function AppealSection() {
  const { data, mutate } = useSWR<{ accounts: FrozenAccountRow[] }>("/api/frozen-accounts", fetcher, {
    refreshInterval: 4000,
  })
  const accounts = data?.accounts ?? []

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [appealText, setAppealText] = useState("")
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [pending, startTransition] = useTransition()

  const allSelected = accounts.length > 0 && selected.size === accounts.length

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === accounts.length ? new Set() : new Set(accounts.map((a) => a.id))))
  }

  function appealSelected() {
    if (selected.size === 0) {
      toast.error("Select at least one frozen account.")
      return
    }
    startTransition(async () => {
      const res = await appealAccounts({ accountIds: Array.from(selected), appealText })
      if (res?.error) {
        toast.error(res.error)
        return
      }
      if (res?.alreadyRunning) {
        toast.info("Those accounts are already being appealed.")
      } else {
        toast.success(`Filing appeals for ${res?.queued ?? selected.size} account(s). Watch the status update below.`)
      }
      setSelected(new Set())
      mutate()
    })
  }

  function appealAll() {
    if (accounts.length === 0) return
    startTransition(async () => {
      const res = await appealAllFrozen({ appealText })
      if (res?.error) {
        toast.error(res.error)
        return
      }
      if (res?.alreadyRunning) {
        toast.info("A fleet-wide appeal is already running.")
      } else {
        toast.success(`Filing appeals for all ${res?.queued ?? accounts.length} frozen account(s).`)
      }
      mutate()
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="border-chart-1/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-chart-1" />
            Appeal frozen accounts
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            When Telegram freezes an account, the agent can file an appeal on its behalf — it opens the Telegram
            service chat and <span className="font-medium text-foreground">@SpamBot</span>, presses the{" "}
            <span className="font-medium text-foreground">Appeal</span> / &quot;This is a mistake&quot; buttons, and
            sends your message. Any reply from Telegram is saved below. An account that unfreezes returns to the active
            pool automatically. This never logs an account out.
          </p>

          <div className="flex flex-col gap-2">
            <Label htmlFor="appeal-text" className="text-sm">
              Appeal message <span className="text-muted-foreground">(optional — sent to @SpamBot)</span>
            </Label>
            <Textarea
              id="appeal-text"
              value={appealText}
              onChange={(e) => setAppealText(e.target.value.slice(0, 1000))}
              placeholder="Leave blank to use the default message, or write your own explanation to Telegram…"
              rows={3}
              className="resize-none"
            />
            <p className="text-right text-xs text-muted-foreground">{appealText.length}/1000</p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              disabled={pending || selected.size === 0}
              onClick={appealSelected}
              className="gap-2 bg-transparent"
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Appeal selected{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
            <Button disabled={pending || accounts.length === 0} onClick={appealAll} className="gap-2">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              Appeal all frozen
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Frozen accounts</h2>
            <p className="text-sm text-muted-foreground">
              {accounts.length} frozen account{accounts.length === 1 ? "" : "s"}
            </p>
          </div>
          {accounts.length > 0 ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all frozen accounts" />
              Select all
            </label>
          ) : null}
        </div>

        {accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Snowflake className="size-6" />
            </div>
            <div>
              <p className="font-medium">No frozen accounts</p>
              <p className="text-sm text-muted-foreground">
                Nothing to appeal right now. Frozen accounts show up here after a health check.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {accounts.map((acc) => {
              const isSelected = selected.has(acc.id)
              const meta = acc.appeal_status ? APPEAL_META[acc.appeal_status] : null
              const Icon = meta?.icon
              const isOpen = expanded.has(acc.id)
              return (
                <div
                  key={acc.id}
                  className={`rounded-xl border p-3 transition-colors ${
                    isSelected ? "border-chart-1 bg-chart-1/5" : "border-border"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggle(acc.id)}
                      aria-label={`Select ${acc.phone_number}`}
                    />
                    <button type="button" onClick={() => toggle(acc.id)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-sm font-medium">{acc.label || acc.phone_number}</p>
                      {acc.label ? <p className="truncate text-xs text-muted-foreground">{acc.phone_number}</p> : null}
                      {acc.frozen_reason ? (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={acc.frozen_reason}>
                          {acc.frozen_reason}
                        </p>
                      ) : null}
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      {acc.appeal_at ? (
                        <span className="hidden text-xs text-muted-foreground sm:inline">{timeAgo(acc.appeal_at)}</span>
                      ) : null}
                      {meta && Icon ? (
                        <Badge className={`gap-1 ${meta.className}`}>
                          <Icon className={`size-3 ${acc.appeal_status === "appealing" ? "animate-spin" : ""}`} />
                          {meta.label}
                        </Badge>
                      ) : (
                        <Badge className="gap-1 border-transparent bg-muted text-muted-foreground">
                          <Snowflake className="size-3" />
                          Frozen
                        </Badge>
                      )}
                    </div>
                  </div>

                  {acc.appeal_result ? (
                    <div className="mt-2 border-t border-border pt-2">
                      <button
                        type="button"
                        onClick={() => toggleExpand(acc.id)}
                        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        <ChevronDown className={`size-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                        {isOpen ? "Hide" : "Show"} appeal transcript
                      </button>
                      {isOpen ? (
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-foreground">
                          {acc.appeal_result}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
