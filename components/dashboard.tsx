"use client"

import { useState } from "react"
import { Radio, Users, LogOut, Eye, Vote, Smile, UserCog, UserPlus, Trash2, MessageSquare, ShieldCheck } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { logoutAction } from "@/app/actions/auth"
import { MobileNav } from "@/components/mobile-nav"
import { AgentStatusBar } from "@/components/agent-status-bar"
import { AccountsSection } from "@/components/accounts-section"
import { LivestreamSection } from "@/components/livestream-section"
import { ViewTargetsSection } from "@/components/view-targets-section"
import { VoteSection } from "@/components/vote-section"
import { ReactionsSection } from "@/components/reactions-section"
import { ChannelJoinSection } from "@/components/channel-join-section"
import { ProfileSection } from "@/components/profile-section"
import { PrpDeleteSection } from "@/components/prp-delete-section"
import { ReviewSection } from "@/components/review-section"
import { AppealSection } from "@/components/appeal-section"

export function Dashboard() {
  const [activeTab, setActiveTab] = useState("accounts")

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Mobile hamburger menu - top left corner */}
            <MobileNav activeTab={activeTab} onTabChange={setActiveTab} />

            <img
              src="/telegram-pro.jpg"
              alt="Telegram Pro"
              className="size-9 rounded-lg object-cover"
            />
            <div>
              <h1 className="text-base font-semibold leading-tight tracking-tight">Telegram Pro</h1>
              <p className="text-xs text-muted-foreground">Manage Your User Using Telegram Pro</p>
            </div>
          </div>

          {/* Desktop logout button with confirmation */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="hidden gap-2 text-muted-foreground md:flex">
                <LogOut className="size-4" />
                <span>Sign out</span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Sign out?</AlertDialogTitle>
                <AlertDialogDescription>
                  You will be signed out of the Telegram Pro control panel and returned to the login screen.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <form action={logoutAction}>
                  <AlertDialogAction type="submit" className="w-full">
                    Sign out
                  </AlertDialogAction>
                </form>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <AgentStatusBar />

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-6">
          <TabsList className="hidden w-full md:flex md:flex-wrap lg:flex-nowrap">
            <TabsTrigger value="accounts" className="gap-2">
              <Users className="size-4" />
              <span className="hidden lg:inline">Userbots</span>
            </TabsTrigger>
            <TabsTrigger value="channel-join" className="gap-2">
              <UserPlus className="size-4" />
              <span className="hidden lg:inline">Channel Join</span>
            </TabsTrigger>
            <TabsTrigger value="livestream" className="gap-2">
              <Radio className="size-4" />
              <span className="hidden lg:inline">Live Stream</span>
            </TabsTrigger>
            <TabsTrigger value="view" className="gap-2">
              <Eye className="size-4" />
              <span className="hidden lg:inline">Live View</span>
            </TabsTrigger>
            <TabsTrigger value="vote" className="gap-2">
              <Vote className="size-4" />
              <span className="hidden lg:inline">Vote</span>
            </TabsTrigger>
            <TabsTrigger value="reactions" className="gap-2">
              <Smile className="size-4" />
              <span className="hidden lg:inline">Reactions</span>
            </TabsTrigger>
            <TabsTrigger value="profile" className="gap-2">
              <UserCog className="size-4" />
              <span className="hidden lg:inline">Profile</span>
            </TabsTrigger>
            <TabsTrigger value="prp-delete" className="gap-2">
              <Trash2 className="size-4" />
              <span className="hidden lg:inline">Prp Delete</span>
            </TabsTrigger>
            <TabsTrigger value="review" className="gap-2">
              <MessageSquare className="size-4" />
              <span className="hidden lg:inline">Review</span>
            </TabsTrigger>
            <TabsTrigger value="appeal" className="gap-2">
              <ShieldCheck className="size-4" />
              <span className="hidden lg:inline">Appeal</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="accounts" className="mt-6">
            <AccountsSection />
          </TabsContent>
          <TabsContent value="channel-join" className="mt-6">
            <ChannelJoinSection />
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
          <TabsContent value="reactions" className="mt-6">
            <ReactionsSection />
          </TabsContent>
          <TabsContent value="profile" className="mt-6">
            <ProfileSection />
          </TabsContent>
          <TabsContent value="prp-delete" className="mt-6">
            <PrpDeleteSection />
          </TabsContent>
          <TabsContent value="review" className="mt-6">
            <ReviewSection />
          </TabsContent>
          <TabsContent value="appeal" className="mt-6">
            <AppealSection />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
