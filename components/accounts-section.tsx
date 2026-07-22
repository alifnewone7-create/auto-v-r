"use client"

import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { AddAccountDialog } from "@/components/add-account-dialog"
import { BuyAccountDialog } from "@/components/buy-account-dialog"
import { ImportAccountsDialog } from "@/components/import-accounts-dialog"
import { AccountCard } from "@/components/account-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { Users, Search, X, SearchX, ShieldAlert, Snowflake, Loader2, Trash2 } from "lucide-react"
import type { TelegramAccount } from "@/lib/types"
import { checkFrozenAccounts, deleteFrozenAccounts } from "@/app/actions/accounts"

type AccountRow = Omit<TelegramAccount, "session_string"> & { has_session: boolean }

export function AccountsSection() {
  const { data, mutate } = useSWR<{ accounts: AccountRow[] }>("/api/accounts", fetcher, {
    refreshInterval: 3000,
  })
  const accounts = data?.accounts ?? []
  const frozenCount = accounts.filter((a) => a.status === "frozen").length

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [checking, setChecking] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleCheckFrozen() {
    setChecking(true)
    try {
      const res = await checkFrozenAccounts()
      if (res?.alreadyRunning) {
        toast.info("A freeze check is already running. Watch the badges update.")
      } else {
        toast.success("Freeze check queued. The agent is probing every account — badges will update as it finds frozen ones.")
      }
      mutate()
    } catch {
      toast.error("Could not start the freeze check.")
    } finally {
      setChecking(false)
    }
  }

  async function handleRemoveFrozen() {
    setRemoving(true)
    try {
      const res = await deleteFrozenAccounts()
      toast.success(`Removed ${res?.deleted ?? 0} frozen account${res?.deleted === 1 ? "" : "s"}.`)
      mutate()
    } catch {
      toast.error("Could not remove frozen accounts.")
    } finally {
      setRemoving(false)
      setConfirmRemove(false)
    }
  }

  // Focus the field as soon as the search box opens.
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])

  const normalized = query.trim().toLowerCase()
  const filtered = normalized
    ? accounts.filter((a) => {
        const phone = (a.phone_number ?? "").toLowerCase()
        const label = (a.label ?? "").toLowerCase()
        // Also match digits-only so "+1 555" and "1555" both find a number.
        const phoneDigits = phone.replace(/\D/g, "")
        const queryDigits = normalized.replace(/\D/g, "")
        return (
          phone.includes(normalized) ||
          label.includes(normalized) ||
          (queryDigits.length > 0 && phoneDigits.includes(queryDigits))
        )
      })
    : accounts

  function closeSearch() {
    setSearchOpen(false)
    setQuery("")
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Userbots</h2>
          <p className="text-sm text-muted-foreground">
            {accounts.length} account{accounts.length === 1 ? "" : "s"} ·{" "}
            {accounts.filter((a) => a.status === "logged_in").length} ready
            {normalized ? ` · ${filtered.length} matching` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {searchOpen ? (
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeSearch()
                }}
                placeholder="Search by number or label…"
                className="w-56 pl-8 pr-8"
                aria-label="Search userbots"
              />
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-0.5 size-7 text-muted-foreground"
                onClick={closeSearch}
                aria-label="Close search"
              >
                <X className="size-4" />
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="icon"
              onClick={() => setSearchOpen(true)}
              aria-label="Search userbots"
            >
              <Search className="size-4" />
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleCheckFrozen}
            disabled={checking || accounts.length === 0}
            className="gap-2"
          >
            {checking ? <Loader2 className="size-4 animate-spin" /> : <ShieldAlert className="size-4" />}
            <span className="hidden sm:inline">Check frozen</span>
          </Button>
          <ImportAccountsDialog onImported={() => mutate()} />
          <BuyAccountDialog onBought={() => mutate()} />
          <AddAccountDialog onAdded={() => mutate()} />
        </div>
      </div>

      {frozenCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-destructive/15 text-destructive">
              <Snowflake className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-destructive">
                {frozenCount} frozen account{frozenCount === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-muted-foreground">
                Telegram froze these — they can no longer view, react, vote, or join streams. Removing them keeps your
                fleet clean.
              </p>
            </div>
          </div>
          <Button
            variant="destructive"
            onClick={() => setConfirmRemove(true)}
            disabled={removing}
            className="gap-2"
          >
            {removing ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Remove {frozenCount} frozen
          </Button>
        </div>
      )}

      <AlertDialog open={confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {frozenCount} frozen account{frozenCount === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes every account Telegram has frozen, along with their jobs and livestream history.
              Frozen accounts can&apos;t be recovered, so this only clears out dead entries. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleRemoveFrozen()
              }}
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? "Removing…" : "Remove frozen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Users className="size-6" />
          </div>
          <div>
            <p className="font-medium">No userbots yet</p>
            <p className="text-sm text-muted-foreground">Add a Telegram number to get started.</p>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <SearchX className="size-6" />
          </div>
          <div>
            <p className="font-medium">No matches</p>
            <p className="text-sm text-muted-foreground">
              {`No userbot matches "${query.trim()}". Try a different number or label.`}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filtered.map((acc) => (
            <AccountCard key={acc.id} account={acc} onChange={() => mutate()} />
          ))}
        </div>
      )}
    </div>
  )
}
