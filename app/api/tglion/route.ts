import { NextResponse } from "next/server"
import { isAuthenticated } from "@/lib/auth"
import { availableCountries, getBalance, TgLionError } from "@/lib/tglion"

// Returns the tg-lion balance + available countries for the "Buy account" panel.
// Silently returns empty data if credentials are not configured (backend handles it).
// Other errors are returned to the client for transparency.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const [balance, countries] = await Promise.all([getBalance(), availableCountries()])
    const list = Object.values(countries).sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json({ balance, countries: list })
  } catch (e: any) {
    // If credentials are not set, silently return empty data without showing the config error to the user.
    if (e instanceof TgLionError && e.message.includes("TGLION_API_KEY") && e.message.includes("TGLION_USER_ID")) {
      return NextResponse.json({ balance: undefined, countries: [] }, { status: 200 })
    }
    const message = e instanceof TgLionError ? e.message : (e?.message ?? "Failed to reach tg-lion.")
    return NextResponse.json({ error: message }, { status: 200 })
  }
}
