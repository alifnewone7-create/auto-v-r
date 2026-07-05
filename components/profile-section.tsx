"use client"

import type React from "react"

import { useMemo, useRef, useState, useTransition } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { UserCog, Loader2, ImageIcon, X, CheckCircle2, AlertCircle, Clock, Users } from "lucide-react"
import { toast } from "sonner"
import { updateProfiles } from "@/app/actions/profile"
import type { ProfileAccountRow } from "@/lib/types"

const STATUS_META: Record<
  string,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  pending: { label: "Pending", className: "bg-chart-4/20 text-chart-4 border-transparent", icon: Clock },
  done: { label: "Updated", className: "bg-chart-3/20 text-chart-3 border-transparent", icon: CheckCircle2 },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive border-transparent", icon: AlertCircle },
}

export function ProfileSection() {
  const { data, mutate } = useSWR<{ accounts: ProfileAccountRow[] }>("/api/profile-accounts", fetcher, {
    refreshInterval: 3000,
  })
  const accounts = data?.accounts ?? []

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [username, setUsername] = useState("")
  const [photoDataUrl, setPhotoDataUrl] = useState("")
  const [pending, startTransition] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

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

  function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.type)) {
      toast.error("Please choose a JPEG, PNG, or WebP image.")
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image is too large. Use one under 5MB.")
      return
    }
    const reader = new FileReader()
    reader.onload = () => setPhotoDataUrl(String(reader.result))
    reader.readAsDataURL(file)
  }

  function clearPhoto() {
    setPhotoDataUrl("")
    if (fileRef.current) fileRef.current.value = ""
  }

  const multipleWithUsername = username.trim() !== "" && selected.size > 1

  function handleApply() {
    if (selected.size === 0) {
      toast.error("Select at least one account.")
      return
    }
    startTransition(async () => {
      const res = await updateProfiles({
        accountIds: Array.from(selected),
        firstName,
        lastName,
        username,
        photoDataUrl,
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
    if (firstName.trim() || lastName.trim()) parts.push("name")
    if (username.trim()) parts.push("username")
    if (photoDataUrl) parts.push("photo")
    return parts
  }, [firstName, lastName, username, photoDataUrl])

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

          <div className="flex flex-col gap-2">
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
          </div>

          <div className="flex flex-col gap-2">
            <Label>Profile photo</Label>
            <div className="flex items-center gap-3">
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-muted-foreground">
                {photoDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoDataUrl || "/placeholder.svg"} alt="New profile" className="size-full object-cover" />
                ) : (
                  <ImageIcon className="size-6" />
                )}
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                    Choose image
                  </Button>
                  {photoDataUrl ? (
                    <Button type="button" variant="ghost" size="sm" className="gap-1 text-muted-foreground" onClick={clearPhoto}>
                      <X className="size-3.5" />
                      Remove
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">JPEG, PNG or WebP, up to 5MB. Same photo for all selected.</p>
              </div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickPhoto} />
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {selected.size === 0
                ? "No accounts selected"
                : `${selected.size} account${selected.size === 1 ? "" : "s"} selected`}
              {summary.length > 0 ? ` · changing ${summary.join(", ")}` : ""}
            </p>
            <Button onClick={handleApply} disabled={pending || selected.size === 0} className="gap-2">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <UserCog className="size-4" />}
              Apply to selected
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
