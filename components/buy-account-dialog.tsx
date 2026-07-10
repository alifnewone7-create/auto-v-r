"use client"

import { useState, useTransition } from "react"
import useSWR from "swr"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ShoppingCart, Wallet, Loader2, AlertCircle } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { buyTgLionNumber } from "@/app/actions/accounts"
import { toast } from "sonner"

interface TgLionCountry {
  name: string
  code: string
  qty: number
  price: string
}

type TgLionData = { balance?: string; countries?: TgLionCountry[]; error?: string }

export function BuyAccountDialog({ onBought }: { onBought: () => void }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  // Only hit tg-lion while the dialog is open; refresh balance/stock periodically.
  const { data, isLoading, mutate } = useSWR<TgLionData>(open ? "/api/tglion" : null, fetcher, {
    refreshInterval: open ? 15000 : 0,
    revalidateOnFocus: false,
  })

  const countries = data?.countries ?? []
  const apiError = data?.error

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await buyTgLionNumber(formData)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      const qty = res?.quantity ?? 1
      toast.success(
        qty > 1
          ? `Ordered ${qty} accounts. The agent is buying and auto-provisioning them one by one — new accounts will appear as each is set up.`
          : `Ordered 1 account. The agent is buying and auto-provisioning it now.`,
      )
      setOpen(false)
      onBought()
      mutate()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="secondary" className="gap-2">
            <ShoppingCart className="size-4" />
            Buy account
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Buy &amp; auto-provision with iamhear</DialogTitle>
          <DialogDescription>
            Pick a country and how many accounts you want. The agent buys them one by one and, for each, logs in,
            collects the API, turns off the old 2FA and sets your new one — fully automatic.
          </DialogDescription>
        </DialogHeader>

        <div className="mb-1 flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Wallet className="size-4" />
            Balance
          </span>
          <span className="font-mono font-medium">
            {isLoading ? "…" : (data?.balance || (apiError ? "—" : "0"))}
          </span>
        </div>

        {apiError ? (
          <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            {apiError}
          </p>
        ) : null}

        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="country_code">Country</Label>
            <select
              id="country_code"
              name="country_code"
              required
              disabled={isLoading || countries.length === 0}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="" disabled>
                {isLoading ? "Loading countries…" : countries.length ? "Select a country" : "No countries available"}
              </option>
              {countries.map((c) => (
                <option key={c.code} value={c.code.toLowerCase()}>
                  {`${c.name} — $${c.price} · ${c.qty} in stock`}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="quantity">Quantity</Label>
            <Input
              id="quantity"
              name="quantity"
              type="number"
              min={1}
              max={100}
              step={1}
              defaultValue={1}
              required
              inputMode="numeric"
            />
            <p className="text-xs text-muted-foreground">
              How many accounts to buy in this country (1–100). They&apos;re bought &amp; set up one by one,
              automatically.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="label">Label (optional)</Label>
            <Input id="label" name="label" placeholder="e.g. Bot" />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending || isLoading || countries.length === 0} className="w-full sm:w-auto">
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Buying…
                </>
              ) : (
                "Buy & auto-provision"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
