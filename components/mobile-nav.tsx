"use client"

import { useState } from "react"
import { Menu, X, Users, LogOut, Eye, Vote, Smile, UserCog, UserPlus, Radio, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { logoutAction } from "@/app/actions/auth"

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
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Toggle menu"
        aria-expanded={isOpen}
      >
        {isOpen ? <X className="size-5" /> : <Menu className="size-5" />}
      </Button>

      {/* Backdrop - tap outside to close */}
      {isOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 top-16 z-40 bg-foreground/30 backdrop-blur-sm"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Mobile Menu */}
      {isOpen && (
        <div className="fixed left-0 right-0 top-16 z-50 max-h-[calc(100vh-4rem)] overflow-y-auto border-b border-border bg-background shadow-lg">
          <nav className="mx-auto flex max-w-6xl flex-col gap-1 p-4">
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
            <form action={logoutAction} className="mt-3 border-t border-border pt-3">
              <Button variant="outline" size="sm" type="submit" className="w-full gap-2">
                <LogOut className="size-4" />
                Sign out
              </Button>
            </form>
          </nav>
        </div>
      )}
    </div>
  )
}
