"use client"

import { Radio, Users, LogOut, Eye, Vote } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { logoutAction } from "@/app/actions/auth"
import { AgentStatusBar } from "@/components/agent-status-bar"
import { AccountsSection } from "@/components/accounts-section"
import { LivestreamSection } from "@/components/livestream-section"
import { ViewTargetsSection } from "@/components/view-targets-section"
import { VoteSection } from "@/components/vote-section"

export function Dashboard() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Radio className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold leading-tight tracking-tight">Iamhear</h1>
              <p className="text-xs text-muted-foreground">Userbot Control Panel</p>
            </div>
          </div>
          <form action={logoutAction}>
            <Button variant="ghost" size="sm" type="submit" className="gap-2 text-muted-foreground">
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <AgentStatusBar />

        <Tabs defaultValue="accounts" className="mt-6">
          <TabsList>
            <TabsTrigger value="accounts" className="gap-2">
              <Users className="size-4" />
              Userbots
            </TabsTrigger>
            <TabsTrigger value="livestream" className="gap-2">
              <Radio className="size-4" />
              Live Stream Join
            </TabsTrigger>
            <TabsTrigger value="view" className="gap-2">
              <Eye className="size-4" />
              Live View
            </TabsTrigger>
            <TabsTrigger value="vote" className="gap-2">
              <Vote className="size-4" />
              Vote
            </TabsTrigger>
          </TabsList>

          <TabsContent value="accounts" className="mt-6">
            <AccountsSection />
          </TabsContent>
          <TabsContent value="livestream" className="mt-6">
            <LivestreamSection />
          </TabsContent>
          <TabsContent value="view" className="mt-6">
            <ViewTargetsSection />
          </TabsContent>
          <TabsContent value="vote" className="mt-6">
            <VoteSection />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
