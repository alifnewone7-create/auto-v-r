"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card } from "@/components/ui/card"
import { Server, Wifi, WifiOff, ListChecks, Loader2 } from "lucide-react"
import type { Agent } from "@/lib/types"

interface AgentsResponse {
  agents: (Agent & { online: boolean })[]
  queued: number
  processing: number
}

export function AgentStatusBar() {
  const { data } = useSWR<AgentsResponse>("/api/agents", fetcher, { refreshInterval: 4000 })
  const agents = data?.agents ?? []
  const onlineAgents = agents.filter((a) => a.online)
  const anyOnline = onlineAgents.length > 0

  return (
    <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div
          className={`flex size-10 items-center justify-center rounded-lg ${
            anyOnline ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
          }`}
        >
          {anyOnline ? <Wifi className="size-5" /> : <WifiOff className="size-5" />}
        </div>
        <div>
          <p className="text-sm font-medium">
            {anyOnline ? `${onlineAgents.length} agent${onlineAgents.length > 1 ? "s" : ""} online` : "No agent online"}
          </p>
          <p className="text-xs text-muted-foreground">
            {anyOnline
              ? onlineAgents.map((a) => a.hostname || a.id).join(", ")
              : "Start the Python agent on your PC or VPS"}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2 text-sm">
          <Server className="size-4 text-muted-foreground" />
          <span className="font-medium">{agents.reduce((n, a) => n + (a.active_accounts || 0), 0)}</span>
          <span className="text-muted-foreground">active</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <ListChecks className="size-4 text-muted-foreground" />
          <span className="font-medium">{data?.queued ?? 0}</span>
          <span className="text-muted-foreground">queued</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className={`size-4 text-muted-foreground ${(data?.processing ?? 0) > 0 ? "animate-spin" : ""}`} />
          <span className="font-medium">{data?.processing ?? 0}</span>
          <span className="text-muted-foreground">running</span>
        </div>
      </div>
    </Card>
  )
}
