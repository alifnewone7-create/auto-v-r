import { Badge } from "@/components/ui/badge"
import type { AccountStatus } from "@/lib/types"

const MAP: Record<AccountStatus, { label: string; className: string }> = {
  new: { label: "New", className: "bg-muted text-muted-foreground" },
  purchased: { label: "Purchased", className: "bg-chart-4/20 text-chart-4 border-transparent" },
  provisioning: { label: "Auto-provisioning…", className: "bg-chart-4/20 text-chart-4 border-transparent" },
  api_pending: { label: "Collecting API…", className: "bg-chart-4/20 text-chart-4 border-transparent" },
  api_code: { label: "Needs my.telegram code", className: "bg-chart-2/20 text-chart-2 border-transparent" },
  api_collected: { label: "API ready", className: "bg-primary/15 text-primary border-transparent" },
  login_pending: { label: "Logging in…", className: "bg-chart-4/20 text-chart-4 border-transparent" },
  login_code: { label: "Needs login code", className: "bg-chart-2/20 text-chart-2 border-transparent" },
  login_2fa: { label: "Needs 2FA password", className: "bg-chart-2/20 text-chart-2 border-transparent" },
  logged_in: { label: "Ready", className: "bg-chart-3/20 text-chart-3 border-transparent" },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive border-transparent" },
  frozen: { label: "Frozen", className: "bg-destructive/15 text-destructive border-transparent" },
}

export function StatusBadge({ status }: { status: AccountStatus }) {
  const cfg = MAP[status] ?? MAP.new
  return <Badge className={cfg.className}>{cfg.label}</Badge>
}
