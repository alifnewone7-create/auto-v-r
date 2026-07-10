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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Eye, Play, Pause, Trash2, Loader2, Link2, AlertCircle, Hash, Pencil } from "lucide-react"
import { toast } from "sonner"
import { addViewTarget, updateViewTarget, toggleViewTarget, removeViewTarget } from "@/app/actions/view"
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

// ---------------------------------------------------------------------------
// Shared "views per post" range field (low to high). Reused by add + edit.
// ---------------------------------------------------------------------------
function ViewRangeFields({
  viewMin,
  setViewMin,
  viewMax,
  setViewMax,
  userbots,
}: {
  viewMin: number
  setViewMin: (n: number) => void
  viewMax: number
  setViewMax: (n: number) => void
  userbots: number
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label className="flex items-center gap-1.5">
        <Hash className="size-4 text-primary" />
        Views per post
      </Label>
      <p className="text-xs text-muted-foreground">
        Pick a low-to-high range and each post gets a random amount inside it (e.g. 30–50 means a random number like 33
        or 42 views each time). Leave both at 0 to view from all your userbots.
      </p>
      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Low</span>
          <Input
            type="number"
            min={0}
            max={userbots || undefined}
            placeholder="0"
            value={viewMin || ""}
            onChange={(e) => {
              const n = Math.max(0, Number.parseInt(e.target.value || "0", 10))
              setViewMin(userbots > 0 ? Math.min(n, userbots) : n)
            }}
            className="h-9 w-24"
          />
        </div>
        <span className="pb-2 text-muted-foreground">to</span>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">High</span>
          <Input
            type="number"
            min={0}
            max={userbots || undefined}
            placeholder="0"
            value={viewMax || ""}
            onChange={(e) => {
              const n = Math.max(0, Number.parseInt(e.target.value || "0", 10))
              setViewMax(userbots > 0 ? Math.min(n, userbots) : n)
            }}
            className="h-9 w-24"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {viewMax > 0
          ? `Each post gets between ${Math.min(viewMin, viewMax)} and ${viewMax} views (capped at your ${userbots} logged-in userbot${
              userbots === 1 ? "" : "s"
            }).`
          : `All ${userbots} logged-in userbot${userbots === 1 ? "" : "s"} will view each post.`}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit dialog: change the chat ID and the views-per-post range.
// ---------------------------------------------------------------------------
function EditDialog({ target, onSaved, userbots }: { target: ViewTarget; onSaved: () => void; userbots: number }) {
  const [open, setOpen] = useState(false)
  const [chatId, setChatId] = useState(target.chat_id != null ? String(target.chat_id) : "")
  const [viewMin, setViewMin] = useState(target.view_min ?? 0)
  const [viewMax, setViewMax] = useState(target.view_max ?? 0)
  const [pending, startTransition] = useTransition()

  function reset() {
    setChatId(target.chat_id != null ? String(target.chat_id) : "")
    setViewMin(target.view_min ?? 0)
    setViewMax(target.view_max ?? 0)
  }

  function save() {
    startTransition(async () => {
      const fd = new FormData()
      fd.set("chat_id", chatId)
      fd.set("view_min", String(viewMin))
      fd.set("view_max", String(viewMax))
      const res = await updateViewTarget(target.id, fd)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success("View settings updated.")
      setOpen(false)
      onSaved()
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) reset()
      }}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        title="Edit"
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-4" />
      </Button>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Live View</DialogTitle>
          <DialogDescription className="truncate">{target.title || target.channel_link}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`edit_view_chat_id_${target.id}`} className="flex items-center gap-1.5">
              <Hash className="size-4 text-primary" />
              Chat ID <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={`edit_view_chat_id_${target.id}`}
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="e.g. -1001234567890"
              className="h-9"
            />
            <p className="text-xs text-muted-foreground">
              Set the numeric chat ID for instant, reliable detection. Leave blank to auto-detect from the link.
            </p>
          </div>
          <Separator />
          <ViewRangeFields
            viewMin={viewMin}
            setViewMin={setViewMin}
            viewMax={viewMax}
            setViewMax={setViewMax}
            userbots={userbots}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending} className="gap-2">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ViewTargetsSection() {
  const { data, mutate } = useSWR<{ targets: ViewTarget[]; userbots: number }>("/api/view-targets", fetcher, {
    refreshInterval: 3000,
  })
  const [pending, startTransition] = useTransition()
  const [link, setLink] = useState("")
  const [chatId, setChatId] = useState("")
  const [viewMin, setViewMin] = useState(0)
  const [viewMax, setViewMax] = useState(0)
  const targets = data?.targets ?? []
  const userbots = data?.userbots ?? 0

  function handleAdd() {
    if (!isTelegramLink(link)) {
      toast.error("Enter a valid Telegram link (@channel or t.me/channel).")
      return
    }
    startTransition(async () => {
      const fd = new FormData()
      fd.set("channel_link", link)
      fd.set("chat_id", chatId)
      fd.set("view_min", String(viewMin))
      fd.set("view_max", String(viewMax))
      const res = await addViewTarget(fd)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success("Channel added. Future posts will be auto-viewed.")
      setLink("")
      setChatId("")
      setViewMin(0)
      setViewMax(0)
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
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel_link">Channel link</Label>
            <div className="relative">
              <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="channel_link"
                name="channel_link"
                placeholder="@channel or t.me/channel"
                className="pl-9"
                value={link}
                onChange={(e) => setLink(stripSpaces(e.target.value))}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="view_chat_id" className="flex items-center gap-1.5">
              <Hash className="size-4 text-primary" />
              Chat ID <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="view_chat_id"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="e.g. -1001234567890"
            />
            <p className="text-xs text-muted-foreground">
              Add the channel&apos;s numeric chat ID so the agent detects it instantly and reliably. Leave blank to
              auto-detect from the link.
            </p>
          </div>

          <Separator />

          <ViewRangeFields
            viewMin={viewMin}
            setViewMin={setViewMin}
            viewMax={viewMax}
            setViewMax={setViewMax}
            userbots={userbots}
          />

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {`Only future posts are viewed by your ${userbots} logged-in userbot${userbots === 1 ? "" : "s"}.`}
            </p>
            <Button type="button" onClick={handleAdd} disabled={pending || !isTelegramLink(link)} className="gap-2">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
              Add channel
            </Button>
          </div>
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
                  <EditDialog target={t} onSaved={() => mutate()} userbots={userbots} />
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
                    <span className="text-muted-foreground">Views per post</span>
                    <span className="font-medium tabular-nums">
                      {t.view_max > 0 ? `${Math.min(t.view_min, t.view_max)}–${t.view_max}` : "All"}
                    </span>
                  </div>
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
