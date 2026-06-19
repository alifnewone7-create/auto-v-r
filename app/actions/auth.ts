"use server"

import { verifyPassword, createSession, destroySession } from "@/lib/auth"
import { redirect } from "next/navigation"

export async function loginAction(_prev: { error?: string } | undefined, formData: FormData) {
  const password = String(formData.get("password") ?? "")
  if (!verifyPassword(password)) {
    return { error: "Wrong password." }
  }
  await createSession()
  redirect("/")
}

export async function logoutAction() {
  await destroySession()
  redirect("/login")
}
