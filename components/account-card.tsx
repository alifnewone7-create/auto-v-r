"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
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
import { StatusBadge } from "@/components/status-badge"
import { Trash2, Loader2, KeyRound, ShieldCheck, Phone, AlertCircle } from "lucide-react"
import { toast } from "sonner"
import { submitMtprotoCode, startLogin, submitLoginCode, deleteAccount } from "@/app/actions/accounts"
import type { AccountStatus, TelegramAccount } from "@/lib/types"

type AccountRow = Omit<TelegramAccount, "session_string"> & { has_session: boolean }

function mask(value: string | null) {
  if (!value) return "—"
  if (value.length <= 6) return value
  return `${value.slice(0, 3)}••••${value.slice(-3)}`
}

const WAITING: AccountStatus[] = ["api_pending", "login_pending"]

export function AccountCard({ account, onChange }: { account: AccountRow; onChange: () => void }) {
  const [pending, startTransition] = useTransition()
  // Two-step delete confirmation: 0 = closed, 1 = first prompt, 2 = final prompt
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0)

  function run(fn: () => Promise<{ error?: string; ok?: boolean } | void>, success?: string) {
    startTransition(async () => {
      const res = await fn()
      if (res && "error" in res && res.error) {
        toast.error(res.error)
        return
      }
      if (success) toast.success(success)
      onChange()
    })
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
            <Phone className="size-4" />
          </div>
          <div>
            <p className="font-medium leading-tight">{account.label || account.phone_number}</p>
            <p className="text-xs text-muted-foreground">{account.phone_number}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <StatusBadge status={account.status} />
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            disabled={pending}
            onClick={() => setDeleteStep(1)}
            aria-label="Delete account"
          >
            <Trash2 className="size-4" />
          </Button>

          {/* Step 1: initial confirmation */}
          <AlertDialog open={deleteStep === 1} onOpenChange={(open) => !open && setDeleteStep(0)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this userbot?</AlertDialogTitle>
                <AlertDialogDescription>
                  {`You're about to delete ${account.label || account.phone_number}. Its stored session and all related data will be removed.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={(e) => {
                    e.preventDefault()
                    setDeleteStep(2)
                  }}
                >
                  Continue
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Step 2: final confirmation */}
          <AlertDialog open={deleteStep === 2} onOpenChange={(open) => !open && setDeleteStep(0)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. This will permanently delete the userbot and its session. Confirm once
                  more to proceed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={(e) => {
                    e.preventDefault()
                    setDeleteStep(0)
                    run(() => deleteAccount(account.id), "Userbot deleted.")
                  }}
                >
                  Delete permanently
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">App title</p>
            <p className="font-medium">{account.app_title}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Short name</p>
            <p className="font-medium">{account.short_name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">API ID</p>
            <p className="font-mono">{account.api_id ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">API hash</p>
            <p className="font-mono">{mask(account.api_hash)}</p>
          </div>
        </div>

        {account.last_error ? (
          <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            {account.last_error}
          </p>
        ) : null}

        <Separator />

        {/* Step-driven action area */}
        {account.status === "purchased" || account.status === "provisioning" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {account.status === "purchased"
              ? "Number purchased — auto-provisioning is queued…"
              : "Auto-provisioning: collecting API, logging in, setting 2FA…"}
          </div>
        ) : null}

        {WAITING.includes(account.status) ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {account.status === "api_pending"
              ? "Agent is working on my.telegram.org…"
              : "Agent is logging in the userbot…"}
          </div>
        ) : null}

        {account.status === "api_code" ? (
          <form
            action={(fd) => run(() => submitMtprotoCode(fd), "Code submitted.")}
            className="flex flex-col gap-2"
          >
            <input type="hidden" name="account_id" value={account.id} />
            <Label htmlFor={`mt-${account.id}`} className="text-xs">
              Enter the code Telegram sent (for my.telegram.org)
            </Label>
            <div className="flex gap-2">
              <Input id={`mt-${account.id}`} name="code" placeholder="12345" inputMode="numeric" required />
              <Button type="submit" disabled={pending} size="sm">
                Submit
              </Button>
            </div>
          </form>
        ) : null}

        {account.status === "api_collected" ? (
          <Button
            onClick={() => run(() => startLogin(account.id), "Login code requested.")}
            disabled={pending}
            className="gap-2"
          >
            <KeyRound className="size-4" />
            Verify &amp; log in userbot
          </Button>
        ) : null}

        {(account.status === "login_code" || account.status === "login_2fa") ? (
          <form
            action={(fd) => run(() => submitLoginCode(fd), "Submitted to agent.")}
            className="flex flex-col gap-2"
          >
            <input type="hidden" name="account_id" value={account.id} />
            <Label htmlFor={`lc-${account.id}`} className="text-xs">
              Enter the Telegram login code
            </Label>
            <Input id={`lc-${account.id}`} name="code" placeholder="12345" inputMode="numeric" required />
            <Label htmlFor={`pw-${account.id}`} className="text-xs">
              {account.status === "login_2fa"
                ? "2FA password (required for this account)"
                : "2FA password (only if this account has one)"}
            </Label>
            <Input
              id={`pw-${account.id}`}
              name="password"
              type="password"
              placeholder="••••••••"
              required={account.status === "login_2fa"}
            />
            <p className="text-[11px] text-muted-foreground">
              Tip: if your account has a cloud password, enter it together with the code.
            </p>
            <Button type="submit" disabled={pending} size="sm" className="mt-1">
              Complete login
            </Button>
          </form>
        ) : null}

        {account.status === "logged_in" ? (
          <div className="flex items-center gap-2 text-sm text-chart-3">
            <ShieldCheck className="size-4" />
            Session stored — ready to join live streams.
          </div>
        ) : null}

        {account.status === "failed" ? (
          <Button
            variant="secondary"
            onClick={() => run(() => startLogin(account.id), "Retrying login…")}
            disabled={pending || !account.api_id}
            size="sm"
          >
            Retry login
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}
