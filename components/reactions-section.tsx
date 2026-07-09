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
import { Smile, Play, Pause, Trash2, Loader2, Link2, AlertCircle, Plus, X, Pencil, Gauge, Hash } from "lucide-react"
import { toast } from "sonner"
import {
  addReactionTarget,
  updateReactionTarget,
  toggleReactionTarget,
  removeReactionTarget,
} from "@/app/actions/reactions"
import type { ReactionMode, ReactionTarget } from "@/lib/types"

// Common Telegram reaction emojis offered as quick-pick chips. Users can also
// type any custom emoji that a channel allows.
const PRESET_EMOJIS = [
  "👍", "👎", "❤️", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🎉", "🤩",
  "🙏", "👌", "🕊", "🤡", "🥱", "😍", "💯", "🤣", "⚡️", "🏆", "💔", "😐",
  "🍓", "🍾", "💋", "😈", "😴", "😭", "👻", "👀", "🙈", "😇", "🤝", "🤗",
  "🫡", "💅", "🗿", "🆒", "😘", "😎", "🤷", "😡",
]

const MODES: { value: ReactionMode; label: string; desc: string }[] = [
  { value: "slow", label: "Slow", desc: "Reactions trickle in slowly over several minutes." },
  { value: "medium", label: "Medium", desc: "Reactions arrive at a natural, moderate pace." },
  { value: "fast", label: "Fast", desc: "Reactions come in quickly, within seconds." },
  { value: "custom", label: "Custom", desc: "All userbots finish within an exact time window you set." },
]

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

function modeLabel(t: ReactionTarget): string {
  if (t.mode === "custom") {
    const h = Math.floor(t.custom_minutes / 60)
    const m = t.custom_minutes % 60
    const parts = [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ")
    return `Custom · ${parts || "1m"}`
  }
  return t.mode.charAt(0).toUpperCase() + t.mode.slice(1)
}

// ---------------------------------------------------------------------------
// Shared config form (emoji picker + speed mode) used for both add and edit.
// ---------------------------------------------------------------------------
function ConfigFields({
  emojis,
  setEmojis,
  mode,
  setMode,
  hours,
  setHours,
  minutes,
  setMinutes,
  reactMin,
  setReactMin,
  reactMax,
  setReactMax,
  userbots,
}: {
  emojis: string[]
  setEmojis: (e: string[]) => void
  mode: ReactionMode
  setMode: (m: ReactionMode) => void
  hours: number
  setHours: (n: number) => void
  minutes: number
  setMinutes: (n: number) => void
  reactMin: number
  setReactMin: (n: number) => void
  reactMax: number
  setReactMax: (n: number) => void
  userbots: number
}) {
  const [custom, setCustom] = useState("")

  function toggle(emoji: string) {
    setEmojis(emojis.includes(emoji) ? emojis.filter((e) => e !== emoji) : [...emojis, emoji])
  }

  function addCustom() {
    const e = custom.trim()
    if (!e) return
    if (!emojis.includes(e)) setEmojis([...emojis, e])
    setCustom("")
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Reaction emojis</Label>
        <p className="text-xs text-muted-foreground">
          Pick the reactions the userbots will use. If a channel does not allow one of these on a post, it is skipped
          for that post automatically.
        </p>

        {emojis.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 rounded-md border border-border bg-muted/40 p-2">
            {emojis.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => toggle(e)}
                className="flex items-center gap-1 rounded-md bg-background px-2 py-1 text-base leading-none shadow-sm"
                title="Remove"
              >
                <span>{e}</span>
                <X className="size-3 text-muted-foreground" />
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-1.5">
          {PRESET_EMOJIS.map((e) => {
            const active = emojis.includes(e)
            return (
              <button
                key={e}
                type="button"
                onClick={() => toggle(e)}
                className={`flex size-9 items-center justify-center rounded-md border text-lg leading-none transition-colors ${
                  active
                    ? "border-primary bg-primary/15"
                    : "border-border bg-background hover:bg-muted"
                }`}
                aria-pressed={active}
              >
                {e}
              </button>
            )
          })}
        </div>

        <div className="flex gap-2">
          <Input
            value={custom}
            onChange={(ev) => setCustom(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault()
                addCustom()
              }
            }}
            placeholder="Add a custom emoji"
            className="h-9"
          />
          <Button type="button" variant="outline" size="sm" onClick={addCustom} className="gap-1">
            <Plus className="size-4" />
            Add
          </Button>
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <Label className="flex items-center gap-1.5">
          <Gauge className="size-4 text-primary" />
          Speed
        </Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                mode === m.value ? "border-primary bg-primary/15 text-foreground" : "border-border hover:bg-muted"
              }`}
              aria-pressed={mode === m.value}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{MODES.find((m) => m.value === mode)?.desc}</p>

        {mode === "custom" ? (
          <div className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
            <Label className="text-xs">Finish all reactions within</Label>
            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Hours</span>
                <Input
                  type="number"
                  min={0}
                  value={hours}
                  onChange={(e) => setHours(Math.max(0, Number.parseInt(e.target.value || "0", 10)))}
                  className="h-9 w-20"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Minutes</span>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  value={minutes}
                  onChange={(e) => setMinutes(Math.max(0, Number.parseInt(e.target.value || "0", 10)))}
                  className="h-9 w-20"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Minimum 1 minute. Userbots react one by one, spread across this exact window so it looks like real users.
            </p>
          </div>
        ) : null}
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <Label className="flex items-center gap-1.5">
          <Hash className="size-4 text-primary" />
          Reactions per post
        </Label>
        <p className="text-xs text-muted-foreground">
          Pick a low-to-high range and each post gets a random amount inside it (e.g. 30–50 means a random number like
          33 or 42 reacts each time). Leave both at 0 to react from all your userbots.
        </p>
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Low</span>
            <Input
              type="number"
              min={0}
              value={reactMin}
              onChange={(e) => setReactMin(Math.max(0, Number.parseInt(e.target.value || "0", 10)))}
              className="h-9 w-24"
            />
          </div>
          <span className="pb-2 text-muted-foreground">to</span>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">High</span>
            <Input
              type="number"
              min={0}
              value={reactMax}
              onChange={(e) => setReactMax(Math.max(0, Number.parseInt(e.target.value || "0", 10)))}
              className="h-9 w-24"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {reactMax > 0
            ? `Each post gets between ${Math.min(reactMin, reactMax)} and ${reactMax} reactions (capped at your ${userbots} logged-in userbot${
                userbots === 1 ? "" : "s"
              }).`
            : `All ${userbots} logged-in userbot${userbots === 1 ? "" : "s"} will react to each post.`}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit dialog
// ---------------------------------------------------------------------------
function EditDialog({ target, onSaved, userbots }: { target: ReactionTarget; onSaved: () => void; userbots: number }) {
  const [open, setOpen] = useState(false)
  const [chatId, setChatId] = useState(target.chat_id != null ? String(target.chat_id) : "")
  const [emojis, setEmojis] = useState<string[]>(target.emojis)
  const [mode, setMode] = useState<ReactionMode>(target.mode)
  const [hours, setHours] = useState(Math.floor(target.custom_minutes / 60))
  const [minutes, setMinutes] = useState(target.custom_minutes % 60)
  const [reactMin, setReactMin] = useState(target.react_min ?? 0)
  const [reactMax, setReactMax] = useState(target.react_max ?? 0)
  const [pending, startTransition] = useTransition()

  function reset() {
    setChatId(target.chat_id != null ? String(target.chat_id) : "")
    setEmojis(target.emojis)
    setMode(target.mode)
    setHours(Math.floor(target.custom_minutes / 60))
    setMinutes(target.custom_minutes % 60)
    setReactMin(target.react_min ?? 0)
    setReactMax(target.react_max ?? 0)
  }

  function save() {
    startTransition(async () => {
      const fd = new FormData()
      fd.set("chat_id", chatId)
      fd.set("emojis", JSON.stringify(emojis))
      fd.set("mode", mode)
      fd.set("custom_hours", String(hours))
      fd.set("custom_minutes", String(minutes))
      fd.set("react_min", String(reactMin))
      fd.set("react_max", String(reactMax))
      const res = await updateReactionTarget(target.id, fd)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success("Reaction settings updated.")
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
          <DialogTitle>Edit reactions</DialogTitle>
          <DialogDescription className="truncate">{target.title || target.channel_link}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`edit_chat_id_${target.id}`} className="flex items-center gap-1.5">
            <Hash className="size-4 text-primary" />
            Chat ID <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id={`edit_chat_id_${target.id}`}
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="e.g. -1001234567890"
            className="h-9"
          />
          <p className="text-xs text-muted-foreground">
            Set the numeric chat ID for instant, reliable detection. Leave blank to auto-detect from the link.
          </p>
        </div>
        <ConfigFields
          emojis={emojis}
          setEmojis={setEmojis}
          mode={mode}
          setMode={setMode}
          hours={hours}
          setHours={setHours}
          minutes={minutes}
          setMinutes={setMinutes}
          reactMin={reactMin}
          setReactMin={setReactMin}
          reactMax={reactMax}
          setReactMax={setReactMax}
          userbots={userbots}
        />
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

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------
export function ReactionsSection() {
  const { data, mutate } = useSWR<{ targets: ReactionTarget[]; userbots: number; max: number }>(
    "/api/reaction-targets",
    fetcher,
    { refreshInterval: 3000 },
  )
  const [pending, startTransition] = useTransition()

  // Add-form state
  const [link, setLink] = useState("")
  const [chatId, setChatId] = useState("")
  const [emojis, setEmojis] = useState<string[]>(["👍", "🔥", "❤️"])
  const [mode, setMode] = useState<ReactionMode>("medium")
  const [hours, setHours] = useState(0)
  const [minutes, setMinutes] = useState(5)
  const [reactMin, setReactMin] = useState(0)
  const [reactMax, setReactMax] = useState(0)

  const targets = data?.targets ?? []
  const userbots = data?.userbots ?? 0
  const max = data?.max ?? 10
  const atLimit = targets.length >= max

  function handleAdd() {
    startTransition(async () => {
      const fd = new FormData()
      fd.set("channel_link", link)
      fd.set("chat_id", chatId)
      fd.set("emojis", JSON.stringify(emojis))
      fd.set("mode", mode)
      fd.set("custom_hours", String(hours))
      fd.set("custom_minutes", String(minutes))
      fd.set("react_min", String(reactMin))
      fd.set("react_max", String(reactMax))
      const res = await addReactionTarget(fd)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success("Channel added. Future posts will be auto-reacted to.")
      setLink("")
      setChatId("")
      setEmojis(["👍", "🔥", "❤️"])
      setMode("medium")
      setHours(0)
      setMinutes(5)
      setReactMin(0)
      setReactMax(0)
      mutate()
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Smile className="size-4 text-primary" />
            Auto-react to a channel
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="reaction_link">Channel link</Label>
            <div className="relative">
              <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="reaction_link"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="@channel, t.me/channel or private invite link"
                className="pl-9"
                disabled={atLimit}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="reaction_chat_id" className="flex items-center gap-1.5">
              <Hash className="size-4 text-primary" />
              Chat ID <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="reaction_chat_id"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="e.g. -1001234567890"
              disabled={atLimit}
            />
            <p className="text-xs text-muted-foreground">
              Add the channel&apos;s numeric chat ID so the agent detects it instantly and reliably. Leave blank to
              auto-detect from the link.
            </p>
          </div>

          <ConfigFields
            emojis={emojis}
            setEmojis={setEmojis}
            mode={mode}
            setMode={setMode}
            hours={hours}
            setHours={setHours}
            minutes={minutes}
            setMinutes={setMinutes}
            reactMin={reactMin}
            setReactMin={setReactMin}
            reactMax={reactMax}
            setReactMax={setReactMax}
            userbots={userbots}
          />

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {`${targets.length}/${max} channels · every new post is reacted to by your ${userbots} logged-in userbot${
                userbots === 1 ? "" : "s"
              }.`}
            </p>
            <Button onClick={handleAdd} disabled={pending || atLimit} className="gap-2">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Add channel
            </Button>
          </div>
          {atLimit ? (
            <p className="text-xs text-destructive">{`Maximum of ${max} channels reached. Remove one to add another.`}</p>
          ) : null}
        </CardContent>
      </Card>

      {targets.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Smile className="size-6" />
          </div>
          <div>
            <p className="font-medium">No channels yet</p>
            <p className="text-sm text-muted-foreground">Add a channel above to auto-react to its future posts.</p>
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
                        await toggleReactionTarget(t.id, t.status === "active" ? "paused" : "active")
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
                        await removeReactionTarget(t.id)
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
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  {t.emojis.map((e, i) => (
                    <span
                      key={`${e}-${i}`}
                      className="flex size-7 items-center justify-center rounded-md bg-muted text-base leading-none"
                    >
                      {e}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Speed</span>
                    <span className="font-medium">{modeLabel(t)}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Per post</span>
                    <span className="font-medium tabular-nums">
                      {t.react_max > 0 ? `${Math.min(t.react_min, t.react_max)}–${t.react_max}` : "All bots"}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Posts reacted</span>
                    <span className="font-medium tabular-nums">{t.posts_reacted}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Reactions sent</span>
                    <span className="font-medium tabular-nums">{t.reactions_sent}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Last post</span>
                    <span className="font-medium">{timeAgo(t.last_post_at)}</span>
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
