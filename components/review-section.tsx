"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  MessageSquare,
  Plus,
  X,
  Trash2,
  Send,
  Loader2,
  ImagePlus,
  Video as VideoIcon,
  ListOrdered,
  CheckCircle2,
  XCircle,
  Clock,
  Link2,
  Users,
  AlertCircle,
  Images,
  Search,
} from "lucide-react"
import { toast } from "sonner"
import { uploadMessageAsset, sendMessageCampaign, deleteMessageCampaign } from "@/app/actions/messages"
import type { MessageCampaignRow, MessageStep, ReviewAccountSlot } from "@/lib/types"
import { parseReviewList } from "@/lib/review-parser"
import { isTelegramLink, stripSpaces } from "@/lib/validation"

// ---------------------------------------------------------------------------
// Local composer types (client-side only; media lives as File until we send)
// ---------------------------------------------------------------------------

type LocalFile = { localId: string; file: File; previewUrl: string; kind: "image" | "video" }
type MediaGroup = { localId: string; files: LocalFile[] }
type SlotState = { texts: string[]; media: MediaGroup[] }

const uid = () => Math.random().toString(36).slice(2, 10)
const emptyGroup = (): MediaGroup => ({ localId: uid(), files: [] })
const defaultSlot = (): SlotState => ({ texts: [""], media: [emptyGroup()] })

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("Could not read file"))
    reader.readAsDataURL(file)
  })
}

function toLocalFile(file: File): LocalFile {
  return {
    localId: uid(),
    file,
    previewUrl: URL.createObjectURL(file),
    kind: file.type.startsWith("video/") ? "video" : "image",
  }
}

const STATUS_STYLES: Record<string, string> = {
  sending: "bg-chart-4/20 text-chart-4 border-transparent",
  done: "bg-chart-3/20 text-chart-3 border-transparent",
  partial: "bg-chart-4/20 text-chart-4 border-transparent",
  failed: "bg-destructive/15 text-destructive border-transparent",
}

// ---------------------------------------------------------------------------
// One numbered account slot: its text boxes + media upload icons
// ---------------------------------------------------------------------------

function SlotCard({
  position,
  account,
  slot,
  onChange,
}: {
  position: number
  account: ReviewAccountSlot
  slot: SlotState
  onChange: (next: SlotState) => void
}) {
  const setTexts = (texts: string[]) => onChange({ ...slot, texts })
  const setMedia = (media: MediaGroup[]) => onChange({ ...slot, media })

  return (
    <Card className="border-border/70">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 py-3">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-xs font-semibold text-primary tabular-nums">
            {position}
          </span>
          <span className="truncate">{account.label || account.phone_number}</span>
        </CardTitle>
        {account.label ? (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{account.phone_number}</span>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Text messages: each box = one separate message */}
        <div className="flex flex-col gap-2">
          {slot.texts.map((text, i) => (
            <div key={i} className="flex items-start gap-2">
              <Textarea
                value={text}
                onChange={(e) => {
                  const next = [...slot.texts]
                  next[i] = e.target.value
                  setTexts(next)
                }}
                placeholder={`Message ${i + 1}`}
                rows={2}
                className="min-h-9 resize-y text-sm"
              />
              {slot.texts.length > 1 ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => setTexts(slot.texts.filter((_, idx) => idx !== i))}
                  aria-label="Remove message"
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-fit gap-1.5 text-xs"
            onClick={() => setTexts([...slot.texts, ""])}
          >
            <Plus className="size-3.5" />
            Add text
          </Button>
        </div>

        <Separator />

        {/* Media icons: each icon = one message. Multiple files in one icon =
            grouped album; a separate icon = a separate message. */}
        <div className="flex flex-wrap items-start gap-2">
          {slot.media.map((group) => (
            <MediaIcon
              key={group.localId}
              group={group}
              canRemove={slot.media.length > 1}
              onAddFiles={(files) => {
                const locals = Array.from(files).map(toLocalFile)
                setMedia(
                  slot.media.map((g) => (g.localId === group.localId ? { ...g, files: [...g.files, ...locals] } : g)),
                )
              }}
              onRemoveFile={(fid) =>
                setMedia(
                  slot.media.map((g) =>
                    g.localId === group.localId ? { ...g, files: g.files.filter((f) => f.localId !== fid) } : g,
                  ),
                )
              }
              onRemoveGroup={() => setMedia(slot.media.filter((g) => g.localId !== group.localId))}
            />
          ))}
          <Button
            variant="outline"
            size="icon"
            className="size-16 shrink-0 border-dashed"
            onClick={() => setMedia([...slot.media, emptyGroup()])}
            aria-label="Add another media message"
            title="Add another media message"
          >
            <Plus className="size-5 text-muted-foreground" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// A single upload "icon": click to pick one or many files (grouped as one album).
function MediaIcon({
  group,
  canRemove,
  onAddFiles,
  onRemoveFile,
  onRemoveGroup,
}: {
  group: MediaGroup
  canRemove: boolean
  onAddFiles: (files: FileList) => void
  onRemoveFile: (fid: string) => void
  onRemoveGroup: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="relative flex flex-col gap-1 rounded-lg border border-border p-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onAddFiles(e.target.files)
          e.target.value = ""
        }}
      />
      {group.files.length === 0 ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex size-16 flex-col items-center justify-center gap-1 rounded-md text-muted-foreground transition-colors hover:bg-muted"
          aria-label="Upload image or video"
        >
          <ImagePlus className="size-5" />
          <span className="text-[10px]">Upload</span>
        </button>
      ) : (
        <div className="flex flex-wrap gap-1">
          {group.files.map((f) => (
            <div key={f.localId} className="group relative size-16 overflow-hidden rounded-md bg-muted">
              {f.kind === "video" ? (
                <div className="flex size-full items-center justify-center">
                  <video src={f.previewUrl} className="size-full object-cover" muted />
                  <VideoIcon className="absolute size-5 text-background drop-shadow" />
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.previewUrl || "/placeholder.svg"} alt="" className="size-full object-cover" />
              )}
              <button
                type="button"
                onClick={() => onRemoveFile(f.localId)}
                className="absolute right-0.5 top-0.5 rounded bg-foreground/70 p-0.5 text-background opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Remove file"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex size-16 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:bg-muted"
            aria-label="Add more to this album"
            title="Add more to this album (grouped)"
          >
            <Plus className="size-4" />
          </button>
        </div>
      )}
      {canRemove ? (
        <button
          type="button"
          onClick={onRemoveGroup}
          className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive p-0.5 text-destructive-foreground"
          aria-label="Remove this media message"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Campaign history card
// ---------------------------------------------------------------------------

function CampaignCard({ campaign, onChanged }: { campaign: MessageCampaignRow; onChanged: () => void }) {
  const [pending, startTransition] = useTransition()
  const sends = campaign.sends
  const sent = sends.filter((s) => s.status === "sent").length
  const failed = sends.filter((s) => s.status === "failed").length
  const busy = sends.filter((s) => s.status === "pending" || s.status === "sending").length

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate text-sm font-medium">{campaign.target_title || campaign.target_link}</CardTitle>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="size-3.5" />
            <span className="font-medium tabular-nums text-foreground">{sent}</span>
            {` of ${campaign.total_count} sent`}
            {failed > 0 ? ` · ${failed} failed` : ""}
            {busy > 0 ? ` · ${busy} in progress` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Badge className={STATUS_STYLES[campaign.status] ?? STATUS_STYLES.sending}>{campaign.status}</Badge>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            title="Delete this campaign"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await deleteMessageCampaign(campaign.id)
                if (res?.error) {
                  toast.error(res.error)
                  return
                }
                toast.success("Campaign deleted.")
                onChanged()
              })
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {campaign.last_error ? (
          <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{campaign.last_error}</span>
          </div>
        ) : null}
        <Separator />
        <div className="flex flex-wrap gap-2">
          {sends.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
              title={s.last_error || undefined}
            >
              <span className="font-semibold tabular-nums text-muted-foreground">{s.position}.</span>
              {s.status === "sent" ? (
                <CheckCircle2 className="size-3.5 text-chart-3" />
              ) : s.status === "failed" ? (
                <XCircle className="size-3.5 text-destructive" />
              ) : s.status === "sending" ? (
                <Loader2 className="size-3.5 animate-spin text-chart-4" />
              ) : (
                <Clock className="size-3.5 text-muted-foreground" />
              )}
              <span className="text-muted-foreground">{s.label || s.phone}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export function ReviewSection() {
  const { data, mutate } = useSWR<{ accounts: ReviewAccountSlot[]; campaigns: MessageCampaignRow[] }>(
    "/api/messages",
    fetcher,
    { refreshInterval: 3000 },
  )
  const accounts = useMemo(() => data?.accounts ?? [], [data])
  const campaigns = data?.campaigns ?? []

  const [slots, setSlots] = useState<Record<number, SlotState>>({})
  const [bulkText, setBulkText] = useState("")
  const [targetLink, setTargetLink] = useState("")
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState("")
  const bulkMediaRef = useRef<HTMLInputElement>(null)

  // Filter accounts by the search box while KEEPING each account's real position
  // (1-based index in the full list) — the bulk list + send logic rely on that
  // number, so we filter a {position, account} view instead of the raw array.
  const visibleAccounts = useMemo(() => {
    const all = accounts.map((account, i) => ({ position: i + 1, account }))
    const q = search.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      ({ position, account }) =>
        String(position).includes(q) ||
        (account.label ?? "").toLowerCase().includes(q) ||
        (account.phone_number ?? "").toLowerCase().includes(q),
    )
  }, [accounts, search])

  const getSlot = (pos: number): SlotState => slots[pos] ?? defaultSlot()
  const setSlot = (pos: number, next: SlotState) => setSlots((prev) => ({ ...prev, [pos]: next }))

  // Apply the numbered/# list to the text boxes of each slot.
  function applyBulkList() {
    const parsed = parseReviewList(bulkText)
    const keys = Object.keys(parsed)
    if (keys.length === 0) {
      toast.error("Nothing to apply. Use a list like: 1. text  then  #another message.")
      return
    }
    setSlots((prev) => {
      const next = { ...prev }
      let applied = 0
      for (const key of keys) {
        const pos = Number(key)
        if (pos < 1 || pos > accounts.length) continue
        const texts = parsed[pos]
        next[pos] = { ...(next[pos] ?? defaultSlot()), texts: texts.length ? texts : [""] }
        applied++
      }
      if (applied === 0) toast.error(`List numbers exceed your ${accounts.length} logged-in accounts.`)
      else toast.success(`Applied text to ${applied} account${applied === 1 ? "" : "s"}.`)
      return next
    })
  }

  // Distribute a batch of picked files one-per-account, in order (path order).
  function distributeBulkMedia(files: FileList) {
    const list = Array.from(files)
    setSlots((prev) => {
      const next = { ...prev }
      let applied = 0
      list.forEach((file, i) => {
        const pos = i + 1
        if (pos > accounts.length) return
        next[pos] = { ...(next[pos] ?? defaultSlot()), media: [{ localId: uid(), files: [toLocalFile(file)] }] }
        applied++
      })
      toast.success(`Set media on ${applied} account${applied === 1 ? "" : "s"} (in order).`)
      return next
    })
  }

  // Build steps for one slot: text boxes first (each a separate message), then
  // each media icon (grouped album, or video if it holds a video).
  async function buildSteps(slot: SlotState): Promise<MessageStep[]> {
    const steps: MessageStep[] = []
    for (const t of slot.texts) {
      const text = t.trim()
      if (text) steps.push({ kind: "text", text })
    }
    for (const group of slot.media) {
      if (group.files.length === 0) continue
      const assetIds: number[] = []
      let hasVideo = false
      for (const lf of group.files) {
        const dataUrl = await fileToDataUrl(lf.file)
        const res = await uploadMessageAsset(dataUrl)
        if ("error" in res) throw new Error(res.error)
        assetIds.push(res.id)
        if (res.kind === "video") hasVideo = true
      }
      steps.push({ kind: hasVideo ? "video" : "album", asset_ids: assetIds })
    }
    return steps
  }

  async function handleSend() {
    if (!isTelegramLink(targetLink)) {
      toast.error("Enter a valid Telegram @username or t.me link for the target user.")
      return
    }
    setSending(true)
    try {
      const payloadAccounts: { accountId: number; steps: MessageStep[] }[] = []
      for (let i = 0; i < accounts.length; i++) {
        const pos = i + 1
        const slot = slots[pos]
        if (!slot) continue
        const steps = await buildSteps(slot)
        if (steps.length > 0) payloadAccounts.push({ accountId: accounts[i].id, steps })
      }
      if (payloadAccounts.length === 0) {
        toast.error("Add at least one message (text or media) for at least one account.")
        return
      }
      const res = await sendMessageCampaign({ targetLink, accounts: payloadAccounts })
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success(
        `Sending to the target from ${res?.count} account${res?.count === 1 ? "" : "s"}, one-by-one.`,
      )
      setSlots({})
      setBulkText("")
      setTargetLink("")
      mutate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong while sending.")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Bulk list + media distribute */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ListOrdered className="size-4 text-primary" />
            Bulk list
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            rows={7}
            placeholder={"1. Great Work Bro\n#nice bro thanks\n2. to good bro nice\n3. awesome sir\n#you are cool\n#just wow"}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {
              "Each number is an account (1 = 1st account, 2 = 2nd, up to your logged-in count). A # line under it is another separate message that same account sends. Apply fills the boxes below."
            }
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              size="sm"
              className="w-full gap-1.5 sm:w-auto"
              onClick={applyBulkList}
              disabled={accounts.length === 0}
            >
              <ListOrdered className="size-4" />
              Apply text
            </Button>
            <input
              ref={bulkMediaRef}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) distributeBulkMedia(e.target.files)
                e.target.value = ""
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1.5 bg-transparent sm:w-auto"
              onClick={() => bulkMediaRef.current?.click()}
              disabled={accounts.length === 0}
            >
              <Images className="size-4" />
              Distribute media (in order)
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Per-account composer */}
      {accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MessageSquare className="size-6" />
          </div>
          <div>
            <p className="font-medium">No logged-in userbots</p>
            <p className="text-sm text-muted-foreground">Log in some accounts first to compose review messages.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Search accounts by number (or name/phone). All show by default. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                inputMode="numeric"
                placeholder="Search account by number..."
                className="pl-9"
                aria-label="Search accounts by number"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {search ? `${visibleAccounts.length} of ${accounts.length}` : `${accounts.length} accounts`}
            </span>
          </div>

          {visibleAccounts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              {`No account matches "${search}".`}
            </div>
          ) : (
            <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
              {visibleAccounts.map(({ position, account }) => (
                <SlotCard
                  key={account.id}
                  position={position}
                  account={account}
                  slot={getSlot(position)}
                  onChange={(next) => setSlot(position, next)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Target + send */}
      <Card className="sticky bottom-4 border-primary/30 shadow-lg">
        <CardContent className="flex flex-col gap-3 pt-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="review_target">Target user link</Label>
            <div className="relative">
              <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="review_target"
                value={targetLink}
                onChange={(e) => {
                  const cleaned = stripSpaces(e.target.value)
                  setTargetLink(cleaned)
                }}
                placeholder="@username or t.me/username"
                className="pl-9"
              />
            </div>
          </div>
          <Button
            className="w-full gap-2"
            disabled={sending || accounts.length === 0 || !isTelegramLink(targetLink)}
            onClick={handleSend}
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {sending ? "Sending..." : "Send to target with userbots"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {
              "Each account messages the target one-by-one with a safe gap. Text boxes send as separate messages; multiple images in one icon send as a grouped album; a separate icon sends separately."
            }
          </p>
        </CardContent>
      </Card>

      {/* History */}
      {campaigns.length > 0 ? (
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-muted-foreground">Recent campaigns</h2>
          {campaigns.map((c) => (
            <CampaignCard key={c.id} campaign={c} onChanged={mutate} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
