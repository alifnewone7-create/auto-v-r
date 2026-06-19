"""
my.telegram.org automation.

Flow this module implements (matches what you'd do by hand):
  1. POST phone to https://my.telegram.org/auth/send_password  -> Telegram sends
     a login code INSIDE the Telegram app (not SMS).
  2. POST phone + code to /auth/login                          -> sets a session
     cookie (stel_token).
  3. GET  /apps  -> if an app already exists, scrape api_id/api_hash.
           else, POST app title/short name to /apps/create, then re-read /apps.

IMPORTANT REALITIES (told to the user already):
  * The login code arrives in the Telegram app, so the website asks you to type
    it in. We never auto-read it here.
  * my.telegram.org is not an official API. If Telegram changes the HTML, the
    scraping regexes below may need updating.
  * One account can usually create only 1-2 apps total.

State between the two steps (the cookie + hash) is persisted on the account row
so the second job can resume even though it's a separate process invocation.
"""

from __future__ import annotations

import re
from typing import Optional

import httpx

BASE = "https://my.telegram.org"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": BASE + "/auth",
    "Origin": BASE,
    "X-Requested-With": "XMLHttpRequest",
}


class MtprotoError(Exception):
    pass


def _client(cookies: dict[str, str] | None = None) -> httpx.Client:
    return httpx.Client(
        base_url=BASE,
        headers=HEADERS,
        cookies=cookies or {},
        timeout=30.0,
        follow_redirects=True,
    )


def send_login_code(phone: str) -> str:
    """
    Step 1: ask my.telegram.org to send the login code to the Telegram app.
    Returns `random_hash` which must be sent back with the code.
    """
    with _client() as c:
        r = c.post("/auth/send_password", data={"phone": phone})
        if r.status_code != 200:
            raise MtprotoError(f"send_password failed: HTTP {r.status_code}")
        data = r.json()
        if not isinstance(data, dict) or "random_hash" not in data:
            raise MtprotoError(f"Unexpected send_password response: {r.text[:200]}")
        return data["random_hash"]


def login(phone: str, random_hash: str, code: str) -> dict[str, str]:
    """
    Step 2: submit the code. Returns the session cookies (incl. stel_token) we
    need for all later /apps calls.
    """
    with _client() as c:
        r = c.post(
            "/auth/login",
            data={"phone": phone, "random_hash": random_hash, "password": code},
        )
        if r.status_code != 200:
            raise MtprotoError(f"login failed: HTTP {r.status_code}")
        # On success the API returns true and sets stel_* cookies.
        if "true" not in r.text.lower():
            raise MtprotoError(f"Login rejected (wrong/expired code?): {r.text[:200]}")
        cookies = {k: v for k, v in c.cookies.items()}
        if not cookies:
            raise MtprotoError("Login succeeded but no session cookie was set.")
        return cookies


# my.telegram.org renders the credentials as the *text* of an uneditable span,
# anchored by a <label for="app_id"> / <label for="app_hash">. The id sits inside
# a <strong> tag, the hash is plain text. Example:
#   <label for="app_id" ...>App api_id:</label>
#   <div class="col-md-7"><span class="...uneditable-input"><strong>31193643</strong></span></div>
#   <label for="app_hash" ...>App api_hash:</label>
#   <div class="col-md-7"><span class="...uneditable-input">1073be...ad13</span></div>
#
# We anchor on `for="app_id"` / `for="app_hash"`, then grab the first number /
# 32-char hex that follows inside the next span. Fallback patterns cover the
# older value="" markup just in case Telegram serves a different template.
_API_ID_PATTERNS = [
    re.compile(r'for="app_id".*?<span[^>]*>\s*(?:<strong>\s*)?(\d+)', re.IGNORECASE | re.DOTALL),
    re.compile(r'app_id[^>]*value="(\d+)"', re.IGNORECASE),
]
_API_HASH_PATTERNS = [
    re.compile(r'for="app_hash".*?<span[^>]*>\s*(?:<strong>\s*)?([a-f0-9]{32})', re.IGNORECASE | re.DOTALL),
    re.compile(r'app_hash[^>]*value="([a-f0-9]{32})"', re.IGNORECASE),
]


def _first_match(patterns: list[re.Pattern], html: str) -> Optional[str]:
    for pat in patterns:
        m = pat.search(html)
        if m:
            return m.group(1)
    return None


def _scrape_credentials(html: str) -> Optional[tuple[str, str]]:
    api_id = _first_match(_API_ID_PATTERNS, html)
    api_hash = _first_match(_API_HASH_PATTERNS, html)
    if api_id and api_hash:
        return api_id, api_hash
    return None


def get_or_create_app(
    cookies: dict[str, str], app_title: str, short_name: str
) -> tuple[str, str]:
    """
    Step 3: read /apps. If credentials already exist, return them. Otherwise
    create the app with the given title/short name, then read them.
    """
    with _client(cookies) as c:
        r = c.get("/apps")
        if r.status_code != 200:
            raise MtprotoError(f"/apps failed: HTTP {r.status_code} (session expired?)")

        existing = _scrape_credentials(r.text)
        if existing:
            return existing

        # Need a hash token from the create form to submit the creation.
        hash_match = re.search(r'name="hash"\s+value="([a-f0-9]+)"', r.text)
        if not hash_match:
            raise MtprotoError("Could not find the app-create form token on /apps.")
        create_hash = hash_match.group(1)

        cr = c.post(
            "/apps/create",
            data={
                "hash": create_hash,
                "app_title": app_title,
                "app_shortname": short_name,
                "app_url": "",
                "app_platform": "other",
                "app_desc": "",
            },
        )
        if cr.status_code != 200:
            raise MtprotoError(f"/apps/create failed: HTTP {cr.status_code}")

        # Re-read to get the freshly created credentials.
        r2 = c.get("/apps")
        creds = _scrape_credentials(r2.text)
        if not creds:
            raise MtprotoError(
                "App creation submitted but could not read api_id/api_hash. "
                "This account may have hit its app limit."
            )
        return creds
