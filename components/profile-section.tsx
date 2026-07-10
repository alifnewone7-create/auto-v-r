"use client"

import type React from "react"

import { useMemo, useRef, useState, useTransition } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { UserCog, Loader2, ImageIcon, X, CheckCircle2, AlertCircle, Clock, Users, ListPlus } from "lucide-react"
import { toast } from "sonner"
import { updateProfiles, uploadProfilePhoto } from "@/app/actions/profile"
import type { ProfileAccountRow } from "@/lib/types"

const STATUS_META: Record<
  string,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  pending: { label: "Pending", className: "bg-chart-4/20 text-chart-4 border-transparent", icon: Clock },
  done: { label: "Updated", className: "bg-chart-3/20 text-chart-3 border-transparent", icon: CheckCircle2 },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive border-transparent", icon: AlertCircle },
}

// Load a file into an <img>, draw it onto a square-capped canvas, and export a
// compressed JPEG data URL. Keeps profile photos small enough for the Server
// Action body limit while staying sharp at Telegram's display sizes.
function compressImage(file: File, maxSize: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext("2d")
      if (!ctx) {
        reject(new Error("no canvas context"))
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL("image/jpeg", quality))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("image load failed"))
    }
    img.src = url
  })
}

export function ProfileSection() {
  const { data, mutate } = useSWR<{ accounts: ProfileAccountRow[] }>("/api/profile-accounts", fetcher, {
    refreshInterval: 3000,
  })
  const accounts = data?.accounts ?? []

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [nameMode, setNameMode] = useState(true) // random name-list mode vs manual name
  const [nameList, setNameList] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [username, setUsername] = useState("")
  const [autoUsername, setAutoUsername] = useState(false) // generate username from name
  const [photoDataUrls, setPhotoDataUrls] = useState<string[]>([]) // pool of images, randomly assigned per account
  const [noRepeat, setNoRepeat] = useState(false) // use each name/photo once, skip extra accounts
  const [pending, startTransition] = useTransition()
  // Tracks the one-by-one photo upload so the button can show "Uploading 2/5…".
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const parsedNames = useMemo(
    () => nameList.split("\n").map((l) => l.trim()).filter(Boolean),
    [nameList],
  )

  const allSelected = accounts.length > 0 && selected.size === accounts.length
  const someSelected = selected.size > 0 && !allSelected

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === accounts.length ? new Set() : new Set(accounts.map((a) => a.id))))
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return

    const added: string[] = []
    let rejected = 0
    for (const file of files) {
      if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.type) || file.size > 15 * 1024 * 1024) {
        rejected++
        continue
      }
      try {
        // Downscale + re-encode as JPEG on the client. Telegram profile photos are
        // shown small, so 640px is plenty, and this keeps each payload well under
        // the Server Action body limit even with several images.
        added.push(await compressImage(file, 640, 0.85))
      } catch {
        rejected++
      }
    }

    if (added.length > 0) setPhotoDataUrls((prev) => [...prev, ...added])
    if (rejected > 0) toast.error(`${rejected} file(s) skipped (must be JPEG, PNG or WebP under 15MB).`)
    if (fileRef.current) fileRef.current.value = "" // allow re-picking the same file(s)
  }

  function removePhoto(index: number) {
    setPhotoDataUrls((prev) => prev.filter((_, i) => i !== index))
  }

  function clearPhotos() {
    setPhotoDataUrls([])
    if (fileRef.current) fileRef.current.value = ""
  }

  const multipleWithUsername = !autoUsername && username.trim() !== "" && selected.size > 1

  // Size of the largest pool being applied (names + photos). In no-repeat mode
  // this caps how many accounts actually change; beyond it, accounts are skipped.
  const poolMax = Math.max(nameMode ? parsedNames.length : 0, photoDataUrls.length)
  const willChange = noRepeat && poolMax > 0 ? Math.min(selected.size, poolMax) : selected.size
  const willSkip = Math.max(0, selected.size - willChange)

  function handleApply() {
    if (selected.size === 0) {
      toast.error("Select at least one account.")
      return
    }
    if (nameMode && parsedNames.length === 0 && photoDataUrls.length === 0 && !(autoUsername ? false : username.trim())) {
      toast.error("Add at least one name to the list (or a photo).")
      return
    }
    startTransition(async () => {
      // Upload photos ONE AT A TIME so each heavy base64 payload travels in its
      // own small request. Sending them all together in updateProfiles used to
      // blow past the Server Action body limit and crash with "this page
      // couldn't load". Here we collect the small asset ids and pass only those.
      const photoAssetIds: number[] = []
      if (photoDataUrls.length > 0) {
        setUploadProgress({ done: 0, total: photoDataUrls.length })
        for (let i = 0; i < photoDataUrls.length; i++) {
          const up = await uploadProfilePhoto(photoDataUrls[i])
          if ("error" in up) {
            setUploadProgress(null)
            toast.error(up.error)
            return
          }
          photoAssetIds.push(up.id)
          setUploadProgress({ done: i + 1, total: photoDataUrls.length })
        }
        setUploadProgress(null)
      }

      const res = await updateProfiles({
        accountIds: Array.from(selected),
        // In name-list mode we send the pool; otherwise the manual first/last.
        names: nameMode ? parsedNames : undefined,
        firstName: nameMode ? "" : firstName,
        lastName: nameMode ? "" : lastName,
        // In auto mode the agent derives the username from the assigned name.
        username: autoUsername ? "" : username,
        autoUsername,
        // Photos are pre-uploaded above; send only their ids (tiny payload).
        photoAssetIds,
        noRepeat,
      })
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success(`Queued profile changes for ${res?.count ?? selected.size} account(s).`)
      mutate()
    })
  }

  const summary = useMemo(() => {
    const parts: string[] = []
    if (nameMode ? parsedNames.length > 0 : firstName.trim() || lastName.trim()) parts.push("name")
    if (autoUsername || username.trim()) parts.push("username")
    if (photoDataUrls.length > 0) parts.push(photoDataUrls.length === 1 ? "photo" : `photo (×${photoDataUrls.length})`)
    return parts
  }, [nameMode, parsedNames, firstName, lastName, autoUsername, username, photoDataUrls])

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCog className="size-4 text-primary" />
            Bulk profile editor
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Name source: a random pool (list) or one manual name for everyone. */}
          <div className="inline-flex w-fit rounded-lg border border-border bg-muted/40 p-1 text-sm">
            <button
              type="button"
              onClick={() => setNameMode(true)}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                nameMode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              Name list (random)
            </button>
            <button
              type="button"
              onClick={() => setNameMode(false)}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                !nameMode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              Single name
            </button>
          </div>

          {nameMode ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="name_list" className="flex items-center gap-1.5">
                <ListPlus className="size-3.5" />
                Name list
              </Label>
              <Textarea
                id="name_list"
                value={nameList}
                onChange={(e) => setNameList(e.target.value)}
                rows={7}
                placeholder={"Rahim Hasan\nAfiya Noor\nTanvir Ahmed\nSadiya Islam\nImran Hossain"}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                One name per line. Each selected account gets a random name from the list. A single word sets only the
                first name (no last name). {parsedNames.length > 0 ? `${parsedNames.length} name(s) ready.` : ""}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="first_name">First name</Label>
                <Input
                  id="first_name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Leave blank to keep"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="last_name">Last name</Label>
                <Input
                  id="last_name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Leave blank to keep"
                />
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox checked={autoUsername} onCheckedChange={(v) => setAutoUsername(Boolean(v))} />
              <span className="text-sm font-medium">Auto-generate username from name</span>
            </label>
            {autoUsername ? (
              <p className="text-xs text-muted-foreground">
                Each account&apos;s username is built from its full name (e.g. &quot;Rahim Hasan&quot; &rarr;
                @rahimhasan####). If it&apos;s taken, a new random one is tried until it&apos;s unique.
              </p>
            ) : (
              <>
                <Label htmlFor="username">Username</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">@</span>
                  <Input
                    id="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Leave blank to keep"
                    className="pl-7"
                  />
                </div>
                {multipleWithUsername ? (
                  <p className="text-xs text-muted-foreground">
                    {`Usernames are unique, so accounts get a suffix: @${username.trim().replace(/^@/, "")}, @${username
                      .trim()
                      .replace(/^@/, "")}1, @${username.trim().replace(/^@/, "")}2 …`}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">5-32 characters: letters, numbers, underscores.</p>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Profile photos</Label>
              {photoDataUrls.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto gap-1 px-2 py-1 text-xs text-muted-foreground"
                  onClick={clearPhotos}
                >
                  <X className="size-3.5" />
                  Clear all
                </Button>
              ) : null}
            </div>

            {photoDataUrls.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {photoDataUrls.map((url, i) => (
                  <div key={i} className="group relative size-16 overflow-hidden rounded-lg border border-border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url || "/placeholder.svg"} alt={`Profile option ${i + 1}`} className="size-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removePhoto(i)}
                      aria-label={`Remove image ${i + 1}`}
                      className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  aria-label="Add more images"
                  className="flex size-16 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:bg-muted/50"
                >
                  <ImageIcon className="size-5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex size-16 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
                  <ImageIcon className="size-6" />
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  Choose images
                </Button>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              JPEG, PNG or WebP. Auto-resized. Add multiple images and each selected account gets a random one.
              {photoDataUrls.length > 0 ? ` ${photoDataUrls.length} image(s) in the pool.` : ""}
            </p>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickPhoto} />
          </div>

          {/* Distribution mode: reuse the pool across all accounts, or use each
              name/photo once and skip the extras. */}
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
            <label className="flex cursor-pointer items-start gap-2">
              <Checkbox checked={noRepeat} onCheckedChange={(v) => setNoRepeat(Boolean(v))} className="mt-0.5" />
              <span className="text-sm font-medium">No repeat &mdash; use each name / photo once, skip extra accounts</span>
            </label>
            <p className="text-xs text-muted-foreground">
              {noRepeat
                ? poolMax > 0
                  ? `Only ${willChange} account${willChange === 1 ? "" : "s"} will change (one per name/photo)${
                      willSkip > 0 ? `, ${willSkip} skipped` : ""
                    }. When counts differ, the larger pool wins (e.g. 3 names + 2 photos = 3 accounts, the 3rd gets a name only).`
                  : "Add a name list or photos above to use this mode."
                : "Off: the pool is reused across every selected account (names/photos repeat as needed)."}
            </p>
          </div>

          <Separator />

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {selected.size === 0
                ? "No accounts selected"
                : `${selected.size} account${selected.size === 1 ? "" : "s"} selected`}
              {selected.size > 0 && noRepeat && poolMax > 0 && willChange !== selected.size
                ? ` · ${willChange} will change`
                : ""}
              {summary.length > 0 ? ` · changing ${summary.join(", ")}` : ""}
            </p>
            <Button onClick={handleApply} disabled={pending || selected.size === 0} className="gap-2">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <UserCog className="size-4" />}
              {uploadProgress
                ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                : "Apply to selected"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Accounts</h2>
            <p className="text-sm text-muted-foreground">
              {accounts.length} logged-in account{accounts.length === 1 ? "" : "s"} available
            </p>
          </div>
          {accounts.length > 0 ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={toggleAll}
                aria-label="Select all accounts"
              />
              Select all
            </label>
          ) : null}
        </div>

        {accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Users className="size-6" />
            </div>
            <div>
              <p className="font-medium">No logged-in accounts</p>
              <p className="text-sm text-muted-foreground">Log in a userbot first to edit its profile.</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {accounts.map((acc) => {
              const isSelected = selected.has(acc.id)
              const meta = acc.profile_status ? STATUS_META[acc.profile_status] : null
              const Icon = meta?.icon
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => toggle(acc.id)}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                    isSelected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                  }`}
                >
                  <Checkbox checked={isSelected} onCheckedChange={() => toggle(acc.id)} aria-label={`Select ${acc.phone_number}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{acc.label || acc.phone_number}</p>
                    {acc.label ? <p className="truncate text-xs text-muted-foreground">{acc.phone_number}</p> : null}
                  </div>
                  {meta && Icon ? (
                    <Badge className={`gap-1 ${meta.className}`} title={acc.profile_error ?? undefined}>
                      <Icon className="size-3" />
                      {meta.label}
                    </Badge>
                  ) : null}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
