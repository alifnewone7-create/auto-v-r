"use client"

import { useState } from "react"
import useSWR from "swr"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MessageSquare, Loader2, Inbox } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import type { AccountMessage } from "@/lib/types"

function timeAgo(iso: string) {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  return `${mins}m ago`
}

export function AccountMessagesDialog({
  accountId,
  phone,
  label,
}: {
  accountId: number
  phone: string
  label: string | null
}) {
  const [open, setOpen] = useState(false)

  // Only poll while the dialog is open. Messages live 30 min, so a fast-ish
  // refresh keeps new login codes appearing quickly without hammering the API.
  const { data, isLoading } = useSWR<{ messages: AccountMessage[] }>(
    open ? `/api/account-messages?account_id=${accountId}` : null,
    fetcher,
    { refreshInterval: 4000, revalidateOnFocus: true },
  )

  const messages = data?.messages ?? []

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="secondary" size="sm" className="gap-2">
            <MessageSquare className="size-4" />
            Messages
          </Button>
        }
      />
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="size-4" />
            Telegram messages
          </DialogTitle>
          <DialogDescription>
            System notices for {label || phone}. Only messages from Telegram are shown, and each disappears 30 minutes
            after it arrives.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
          {isLoading && messages.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
              <Inbox className="size-6" />
              <p>No recent messages.</p>
              <p className="text-xs">New messages from Telegram will show up here automatically.</p>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className="rounded-lg border border-border bg-secondary/40 p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">{m.sender}</span>
                  <span className="text-[11px] text-muted-foreground">{timeAgo(m.created_at)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{m.body}</p>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
