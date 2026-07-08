"use client"

import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { AddAccountDialog } from "@/components/add-account-dialog"
import { BuyAccountDialog } from "@/components/buy-account-dialog"
import { ImportAccountsDialog } from "@/components/import-accounts-dialog"
import { AccountCard } from "@/components/account-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Users, Search, X, SearchX } from "lucide-react"
import type { TelegramAccount } from "@/lib/types"

type AccountRow = Omit<TelegramAccount, "session_string"> & { has_session: boolean }

export function AccountsSection() {
  const { data, mutate } = useSWR<{ accounts: AccountRow[] }>("/api/accounts", fetcher, {
    refreshInterval: 3000,
  })
  const accounts = data?.accounts ?? []

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

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
          <ImportAccountsDialog onImported={() => mutate()} />
          <BuyAccountDialog onBought={() => mutate()} />
          <AddAccountDialog onAdded={() => mutate()} />
        </div>
      </div>

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
