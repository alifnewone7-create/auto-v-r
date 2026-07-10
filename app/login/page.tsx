import { isAuthenticated } from "@/lib/auth"
import { redirect } from "next/navigation"
import { LoginForm } from "@/components/login-form"

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/")

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img
            src="/telegram-pro.jpg"
            alt="Telegram Pro"
            className="size-16 rounded-2xl object-cover"
          />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Telegram Pro</h1>
            <p className="text-sm text-muted-foreground">Sign in to manage your users</p>
          </div>
        </div>
        <LoginForm />
      </div>
    </main>
  )
}
