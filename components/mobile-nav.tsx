"use client"

import { useState } from "react"
import { Menu, X, Users, LogOut, Eye, Vote, Smile, UserCog, UserPlus, Radio, Trash2, MessageSquare, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { logoutAction } from "@/app/actions/auth"
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

interface Tab {
  value: string
  label: string
  icon: React.ReactNode
}

const TABS: Tab[] = [
  { value: "accounts", label: "Userbots", icon: <Users className="size-4" /> },
  { value: "channel-join", label: "Channel Join", icon: <UserPlus className="size-4" /> },
  { value: "livestream", label: "Live Stream Join", icon: <Radio className="size-4" /> },
  { value: "view", label: "Live View", icon: <Eye className="size-4" /> },
  { value: "vote", label: "Vote", icon: <Vote className="size-4" /> },
  { value: "reactions", label: "Reactions", icon: <Smile className="size-4" /> },
  { value: "profile", label: "Profile", icon: <UserCog className="size-4" /> },
  { value: "prp-delete", label: "Prp Delete", icon: <Trash2 className="size-4" /> },
  { value: "review", label: "Review", icon: <MessageSquare className="size-4" /> },
  { value: "appeal", label: "Appeal", icon: <ShieldCheck className="size-4" /> },
]

interface MobileNavProps {
  activeTab: string
  onTabChange: (tab: string) => void
}

export function MobileNav({ activeTab, onTabChange }: MobileNavProps) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="md:hidden">
      {/* Hamburger Menu Button - top left corner, mobile only */}
      <Button
        variant="ghost"
        size="icon"
        className="-ml-1.5"
        onClick={() => setIsOpen(true)}
        aria-label="Open menu"
        aria-expanded={isOpen}
      >
        <Menu className="size-5" />
      </Button>

      {/* Backdrop - tap outside to close */}
      <div
        className={`fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm transition-opacity duration-300 ${
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsOpen(false)}
        aria-hidden={!isOpen}
      />

      {/* Left-side sliding sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-background shadow-xl transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        {/* Sidebar header with logo + close */}
        <div className="flex items-center justify-between gap-2 border-b border-border p-4">
          <div className="flex items-center gap-3">
            <img src="/telegram-pro.jpg" alt="Telegram Pro" className="size-9 rounded-lg object-cover" />
            <div>
              <p className="text-sm font-semibold leading-tight tracking-tight">Telegram Pro</p>
              <p className="text-xs text-muted-foreground">Control Panel</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)} aria-label="Close menu">
            <X className="size-5" />
          </Button>
        </div>

        {/* Nav items */}
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => {
                onTabChange(tab.value)
                setIsOpen(false)
              }}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab.value
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-muted"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Logout with confirmation */}
        <div className="border-t border-border p-4">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full gap-2">
                <LogOut className="size-4" />
                Sign out
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
      </aside>
    </div>
  )
}
