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
import { Eye, Play, Pause, Trash2, Loader2, Link2, AlertCircle } from "lucide-react"
import { toast } from "sonner"
import { addViewTarget, toggleViewTarget, removeViewTarget } from "@/app/actions/view"
import type { ViewTarget } from "@/lib/types"
import { isTelegramLink, stripSpaces } from "@/lib/validation"

const STATUS_STYLES: Record<string, string> = {
  active: "bg-chart-3/20 text-chart-3 border-transparent",
  paused: "bg-muted text-muted-foreground",
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never"
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function ViewTargetsSection() {
  const { data, mutate } = useSWR<{ targets: ViewTarget[]; userbots: number }>("/api/view-targets", fetcher, {
    refreshInterval: 3000,
  })
  const [pending, startTransition] = useTransition()
  const targets = data?.targets ?? []
  const userbots = data?.userbots ?? 0

  function handleAdd(formData: FormData) {
    const link = String(formData.get("channel_link") || "")
    if (!isTelegramLink(link)) {
      toast.error("Enter a valid Telegram link (@channel or t.me/channel).")
      return
    }
    startTransition(async () => {
      const res = await addViewTarget(formData)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success("Channel added. Future posts will be auto-viewed.")
      ;(document.getElementById("view-form") as HTMLFormElement | null)?.reset()
      mutate()
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Eye className="size-4 text-primary" />
            Auto-view a channel
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form id="view-form" action={handleAdd} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="channel_link">Channel link</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="channel_link"
                    name="channel_link"
                    placeholder="@channel or t.me/channel"
                    className="pl-9"
                    required
                    onInput={(e) => {
                      e.currentTarget.value = stripSpaces(e.currentTarget.value)
                    }}
                  />
                </div>
                <Button type="submit" disabled={pending} className="gap-2">
                  {pending ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
                  Add channel
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {`Only future posts are viewed. Every new post is viewed by all ${userbots} logged-in userbot${userbots === 1 ? "" : "s"}.`}
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      {targets.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Eye className="size-6" />
          </div>
          <div>
            <p className="font-medium">No channels watched yet</p>
            <p className="text-sm text-muted-foreground">Add a channel above to auto-view its future posts.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {targets.map((t) => (
            <Card key={t.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div className="min-w-0">
                  <CardTitle className="truncate text-sm font-medium">{t.title || t.channel_link}</CardTitle>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{t.channel_link}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Badge className={STATUS_STYLES[t.status] ?? STATUS_STYLES.paused}>{t.status}</Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    title={t.status === "active" ? "Pause" : "Resume"}
                    onClick={() =>
                      startTransition(async () => {
                        await toggleViewTarget(t.id, t.status === "active" ? "paused" : "active")
                        mutate()
                      })
                    }
                  >
                    {t.status === "active" ? <Pause className="size-4" /> : <Play className="size-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    title="Remove"
                    onClick={() =>
                      startTransition(async () => {
                        await removeViewTarget(t.id)
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
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Posts viewed</span>
                    <span className="font-medium tabular-nums">{t.posts_viewed}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Total views sent</span>
                    <span className="font-medium tabular-nums">{t.views_sent}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Last post</span>
                    <span className="font-medium">{timeAgo(t.last_post_at)}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Last checked</span>
                    <span className="font-medium">{timeAgo(t.last_checked_at)}</span>
                  </div>
                </div>
                {t.last_error ? (
                  <div className="mt-3 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                    <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="break-words">{t.last_error}</span>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
