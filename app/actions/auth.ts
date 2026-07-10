"use server"

import { verifyCredentials, createSession, destroySession } from "@/lib/auth"
import { redirect } from "next/navigation"

export async function loginAction(_prev: { error?: string } | undefined, formData: FormData) {
  const username = String(formData.get("username") ?? "")
  const password = String(formData.get("password") ?? "")
  const secret = String(formData.get("secret") ?? "")
  if (!username || !password || !secret) {
    return { error: "Enter username, password and secret." }
  }
  if (!verifyCredentials(username, password, secret)) {
    return { error: "Invalid credentials." }
  }
  await createSession()
  redirect("/")
}

export async function logoutAction() {
  await destroySession()
  redirect("/login")
}
