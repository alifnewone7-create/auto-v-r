import { NextResponse } from "next/server"
import { isAuthenticated } from "@/lib/auth"
import { availableCountries, getBalance, TgLionError } from "@/lib/tglion"

// Returns the tg-lion balance + available countries for the "Buy account" panel.
// Never throws to the client: config/network problems come back as { error }.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const [balance, countries] = await Promise.all([getBalance(), availableCountries()])
    const list = Object.values(countries).sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json({ balance, countries: list })
  } catch (e: any) {
    const message = e instanceof TgLionError ? e.message : (e?.message ?? "Failed to reach tg-lion.")
    return NextResponse.json({ error: message }, { status: 200 })
  }
}
