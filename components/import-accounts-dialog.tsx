"use client"

import { useRef, useState, useTransition } from "react"
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
import { Upload, FileSpreadsheet } from "lucide-react"
import { importAccountsCsv } from "@/app/actions/accounts"
import { toast } from "sonner"

export function ImportAccountsDialog({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await importAccountsCsv(formData)
      if (res?.error) {
        toast.error(res.error)
        return
      }
      const parts = [`${res.inserted} added`, `${res.updated} updated`]
      if (res.skipped) parts.push(`${res.skipped} skipped`)
      toast.success(`Import complete — ${parts.join(", ")}.`)
      if (res.errors && res.errors.length > 0) {
        toast.error(`${res.errors.length} row(s) had problems. First: ${res.errors[0]}`)
      }
      setOpen(false)
      setFileName(null)
      formRef.current?.reset()
      onImported()
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setFileName(null)
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" className="gap-2 bg-transparent">
            <Upload className="size-4" />
            Import CSV
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import accounts from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV export of your accounts. Rows are matched by phone number — existing accounts are updated,
            new ones are added. Sessions and API keys are imported as-is.
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="file">CSV file</Label>
            <Input
              id="file"
              name="file"
              type="file"
              accept=".csv,text/csv"
              required
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
            />
            {fileName && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileSpreadsheet className="size-3.5" />
                {fileName}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Expected columns: phone_number, label, app_title, short_name, api_id, api_hash, session_string, status,
              two_factor_required, mtproto_hash, login_hash.
            </p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending} className="w-full sm:w-auto">
              {pending ? "Importing..." : "Import accounts"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
