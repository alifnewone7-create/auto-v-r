import { isAuthenticated } from "@/lib/auth"
import { redirect } from "next/navigation"
import { LoginForm } from "@/components/login-form"
import { Radio } from "lucide-react"

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/")

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Radio className="size-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Iamhear Control Panel</h1>
            <p className="text-sm text-muted-foreground">Sign in to manage your userbots</p>
          </div>
        </div>
        <LoginForm />
      </div>
    </main>
  )
}
