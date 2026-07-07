"""
tg-lion.net API client.

tg-lion sells ready Telegram phone numbers and, crucially, lets us READ the
login code Telegram sends to that number (getCode) plus the account's current
cloud (2FA) password. That is what makes fully automatic provisioning possible:
we never need a human to type the SMS/app code.

API (all GET, all return JSON):
  action=get_balance          -> { status, balance }
  action=available_countries  -> { status, countries: { CODE: {...} } }
  action=country_info         -> single country dict (optionally by country_code)
  action=getNumber            -> { status, Number, price, new_balance, ... }
  action=getCode              -> { status, Number, code, pass }

Config comes from the environment (same .env the rest of the agent uses):
  TGLION_API_KEY   (required)
  TGLION_USER_ID   (required)   -> sent as the `YourID` parameter
  TGLION_BASE_URL  (optional)   -> defaults to https://www.tg-lion.net

Every call parses JSON defensively: if tg-lion returns an empty body or an HTML
error page (rate-limit, maintenance, bad key), we raise a clear TgLionError
instead of the cryptic "Expecting value: line 1 column 1 (char 0)".
"""

from __future__ import annotations

import os
import time
from typing import Any, Optional

import httpx

BASE_URL = os.environ.get("TGLION_BASE_URL", "https://www.tg-lion.net").rstrip("/")


class TgLionError(Exception):
    pass


def _creds() -> tuple[str, str]:
    api_key = os.environ.get("TGLION_API_KEY", "").strip()
    user_id = os.environ.get("TGLION_USER_ID", "").strip()
    if not api_key or not user_id:
        raise TgLionError(
            "TGLION_API_KEY and TGLION_USER_ID must be set in the agent's .env "
            "to buy numbers / read login codes from tg-lion."
        )
    return api_key, user_id


def _call(action: str, extra: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Perform one tg-lion API call and return the parsed JSON object."""
    api_key, user_id = _creds()
    params: dict[str, Any] = {"action": action, "apiKey": api_key, "YourID": user_id}
    if extra:
        params.update({k: v for k, v in extra.items() if v is not None})

    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as c:
            r = c.get(BASE_URL, params=params)
    except httpx.HTTPError as e:
        raise TgLionError(f"tg-lion request failed ({action}): {e}")

    if r.status_code != 200:
        raise TgLionError(f"tg-lion {action} failed: HTTP {r.status_code}")

    body = (r.text or "").strip()
    if not body:
        raise TgLionError(
            f"tg-lion returned an empty response for {action} "
            "(likely rate-limited or an invalid API key). Try again shortly."
        )
    try:
        data = r.json()
    except ValueError:
        raise TgLionError(
            f"tg-lion did not return JSON for {action} "
            f"(likely blocked/maintenance or a bad key): {body[:200]}"
        )
    if not isinstance(data, dict):
        raise TgLionError(f"Unexpected tg-lion {action} response: {body[:200]}")

    # tg-lion signals failures with status != 'ok' and/or an 'error'/'message' key.
    status = str(data.get("status", "")).lower()
    if status and status not in ("ok", "success"):
        msg = data.get("error") or data.get("message") or body[:200]
        raise TgLionError(f"tg-lion {action} error: {msg}")
    return data


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_balance() -> str:
    """Return the account balance string, e.g. '260.5 USD'."""
    return str(_call("get_balance").get("balance", "")).strip()


def available_countries() -> dict[str, Any]:
    """Return the { CODE: { name, code_Num, code, qty, price } } map."""
    data = _call("available_countries")
    return data.get("countries", {}) or {}


def country_info(country_code: Optional[str] = None) -> dict[str, Any]:
    return _call("country_info", {"country_code": country_code})


def get_number(country_code: str, max_price: Optional[str] = None) -> dict[str, Any]:
    """
    Buy a number from `country_code`. Returns the raw dict which includes
    'Number', 'price' and 'new_balance'.
    """
    if not country_code:
        raise TgLionError("country_code is required to buy a number.")
    return _call("getNumber", {"country_code": country_code, "maxPrice": max_price})


def get_code(number: str) -> dict[str, Any]:
    """
    Read the most recent login code Telegram sent to `number`, plus the account's
    current cloud password. Returns { 'code': ..., 'pass': ... } (keys may be
    absent until Telegram has actually delivered a code).
    """
    if not number:
        raise TgLionError("number is required to read a code.")
    return _call("getCode", {"number": number})


def poll_code(
    number: str,
    *,
    attempts: int = 20,
    delay: float = 3.0,
    different_from: Optional[str] = None,
) -> tuple[str, Optional[str]]:
    """
    Poll getCode until Telegram has delivered a login code, returning
    (code, password). Telegram takes a few seconds to send the code after we
    trigger a login, so we retry.

    `different_from`: when we've already consumed one code in this provisioning
    run (e.g. the my.telegram.org code) and now need the NEXT one, pass the old
    code so we keep polling until a genuinely new code arrives instead of
    re-reading the stale one.
    """
    last_err: Optional[str] = None
    for _ in range(max(1, attempts)):
        try:
            data = get_code(number)
            code = str(data.get("code") or "").strip()
            passwd = data.get("pass")
            passwd = str(passwd).strip() if passwd not in (None, "") else None
            if code and (different_from is None or code != different_from):
                return code, passwd
        except TgLionError as e:
            last_err = str(e)
        time.sleep(delay)
    raise TgLionError(
        last_err
        or f"tg-lion did not deliver a login code for {number} in time. "
        "Telegram may be slow — the provision job will retry."
    )
