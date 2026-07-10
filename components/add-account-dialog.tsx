"use client"

import { useState, useTransition } from "react"
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
import { Plus } from "lucide-react"
import { addAccount } from "@/app/actions/accounts"
import { toast } from "sonner"

export function AddAccountDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await addAccount(formData)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      toast.success("Account added. The agent will log into my.telegram.org and request a code.")
      setOpen(false)
      onAdded()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button className="gap-2" aria-label="Add account">
            <Plus className="size-4" />
            <span className="hidden sm:inline">Add account</span>
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Telegram account</DialogTitle>
          <DialogDescription>
            Enter the phone number. The agent logs into my.telegram.org and creates the app automatically.
          </DialogDescription>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="phone">Phone number</Label>
            <Input id="phone" name="phone" placeholder="+8801XXXXXXXXX" required autoFocus />
            <p className="text-xs text-muted-foreground">Include the country code.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="label">Label (optional)</Label>
            <Input id="label" name="label" placeholder="e.g. Bot #1" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="app_title">App title</Label>
              <Input id="app_title" name="app_title" defaultValue="Iamhear" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="short_name">Short name</Label>
              <Input id="short_name" name="short_name" defaultValue="iamheardeveloper" />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending} className="w-full sm:w-auto">
              {pending ? "Adding..." : "Add & collect API"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
