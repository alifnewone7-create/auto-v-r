"use client"

import { useTransition } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Radio, LogOut, Trash2, Loader2, CheckCircle2, XCircle, Link2 } from "lucide-react"
import { toast } from "sonner"
import { joinLivestream, leaveLivestream, deleteLivestream } from "@/app/actions/livestream"
import type { LivestreamTarget } from "@/lib/types"

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

export function LivestreamSection() {
  const { data, mutate } = useSWR<{ targets: TargetRow[] }>("/api/livestream", fetcher, {
    refreshInterval: 3000,
  })
  const [pending, startTransition] = useTransition()
  const targets = data?.targets ?? []

  function handleJoin(formData: FormData) {
    startTransition(async () => {
      const res = await joinLivestream(formData)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success(`Dispatched join to ${res?.count} userbot${res?.count === 1 ? "" : "s"}.`)
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
          <form action={handleJoin} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="chat_link">Channel / group link</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="chat_link"
                    name="chat_link"
                    placeholder="@channel, t.me/link or t.me/+invite"
                    className="pl-9"
                    required
                  />
                </div>
                <Button type="submit" disabled={pending} className="gap-2">
                  {pending ? <Loader2 className="size-4 animate-spin" /> : <Radio className="size-4" />}
                  Join with all userbots
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Public or private link. All logged-in userbots join the chat, then its active live stream (listen-only).
              </p>
            </div>
          </form>
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
            <Card key={t.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div className="min-w-0">
                  <CardTitle className="truncate text-sm font-medium">{t.chat_link}</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.joined_count}/{t.total_count} joined
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Badge className={STATUS_STYLES[t.status] ?? STATUS_STYLES.idle}>{t.status}</Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    title="Leave with all userbots"
                    onClick={() =>
                      startTransition(async () => {
                        await leaveLivestream(t.id)
                        toast.success("Leave dispatched.")
                        mutate()
                      })
                    }
                  >
                    <LogOut className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    title="Remove"
                    onClick={() =>
                      startTransition(async () => {
                        await deleteLivestream(t.id)
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
                <div className="flex flex-wrap gap-2">
                  {t.participants.map((p) => (
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
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
