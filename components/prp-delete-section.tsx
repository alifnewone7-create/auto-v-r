"use client"

import type React from "react"

import { useState, useTransition } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Trash2, Loader2, Users, CheckCircle2, AlertCircle, Clock, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { deleteProfilePhotos } from "@/app/actions/profile"
import type { ProfileAccountRow } from "@/lib/types"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

const STATUS_META: Record<
  string,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  pending: { label: "Pending", className: "bg-chart-4/20 text-chart-4 border-transparent", icon: Clock },
  done: { label: "Deleted", className: "bg-chart-3/20 text-chart-3 border-transparent", icon: CheckCircle2 },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive border-transparent", icon: AlertCircle },
}

export function PrpDeleteSection() {
  const { data, mutate } = useSWR<{ accounts: ProfileAccountRow[] }>("/api/profile-accounts", fetcher, {
    refreshInterval: 3000,
  })
  const accounts = data?.accounts ?? []

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleting, startDeleteTransition] = useTransition()
  // Two-step confirmation: step 1 = first warning, step 2 = final "are you sure".
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0)

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

  function startFlow() {
    if (selected.size === 0) {
      toast.error("Select at least one account.")
      return
    }
    setConfirmStep(1)
  }

  function handleConfirmedDelete() {
    setConfirmStep(0)
    startDeleteTransition(async () => {
      const res = await deleteProfilePhotos({ accountIds: Array.from(selected) })
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success(
        `Queued photo deletion for ${res?.count ?? selected.size} account(s). Accounts without a photo are skipped automatically.`,
      )
      mutate()
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="size-4 text-destructive" />
            Prp Delete — wipe profile photos
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Select accounts below, then delete every profile picture — the{" "}
            <span className="font-medium text-foreground">current</span> one and{" "}
            <span className="font-medium text-foreground">all older</span> photos. Accounts with no photo are skipped
            safely and this never logs a userbot out. You&apos;ll confirm twice before anything is removed.
          </p>
          <Button
            variant="destructive"
            disabled={deleting || selected.size === 0}
            onClick={startFlow}
            className="shrink-0 gap-2"
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Delete photos
            {selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
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
              <p className="text-sm text-muted-foreground">Log in a userbot first to manage its photos.</p>
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
                    isSelected ? "border-destructive bg-destructive/5" : "border-border hover:bg-muted/50"
                  }`}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggle(acc.id)}
                    aria-label={`Select ${acc.phone_number}`}
                  />
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

      {/* Step 1 of 2: first confirmation */}
      <AlertDialog open={confirmStep === 1} onOpenChange={(o) => !o && setConfirmStep(0)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete profile photos? (1 of 2)</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;re about to remove the current and all previous profile pictures for{" "}
              <span className="font-medium text-foreground">
                {selected.size} account{selected.size === 1 ? "" : "s"}
              </span>
              . This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                setConfirmStep(2)
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Step 2 of 2: final confirmation */}
      <AlertDialog open={confirmStep === 2} onOpenChange={(o) => !o && setConfirmStep(0)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure? (2 of 2)</AlertDialogTitle>
            <AlertDialogDescription>
              This is the final confirmation. Every profile photo for the selected{" "}
              {selected.size} account{selected.size === 1 ? "" : "s"} will be permanently deleted from Telegram.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmedDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
