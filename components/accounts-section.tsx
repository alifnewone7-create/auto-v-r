"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { AddAccountDialog } from "@/components/add-account-dialog"
import { BuyAccountDialog } from "@/components/buy-account-dialog"
import { ImportAccountsDialog } from "@/components/import-accounts-dialog"
import { AccountCard } from "@/components/account-card"
import { Users } from "lucide-react"
import type { TelegramAccount } from "@/lib/types"

type AccountRow = Omit<TelegramAccount, "session_string"> & { has_session: boolean }

export function AccountsSection() {
  const { data, mutate } = useSWR<{ accounts: AccountRow[] }>("/api/accounts", fetcher, {
    refreshInterval: 3000,
  })
  const accounts = data?.accounts ?? []

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Userbots</h2>
          <p className="text-sm text-muted-foreground">
            {accounts.length} account{accounts.length === 1 ? "" : "s"} ·{" "}
            {accounts.filter((a) => a.status === "logged_in").length} ready
          </p>
        </div>
        <div className="flex items-center gap-2">
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
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {accounts.map((acc) => (
            <AccountCard key={acc.id} account={acc} onChange={() => mutate()} />
          ))}
        </div>
      )}
    </div>
  )
}
