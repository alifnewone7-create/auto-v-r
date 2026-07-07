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
  TGLION_BASE_URL  (optional)   -> defaults to https://tg-lion.net (APEX, not www.)

Every call parses JSON defensively: if tg-lion returns an empty body or an HTML
error page (rate-limit, maintenance, bad key), we raise a clear TgLionError
instead of the cryptic "Expecting value: line 1 column 1 (char 0)".
"""

from __future__ import annotations

import os
import re
import time
from typing import Any, Optional

import httpx

# NOTE: use the APEX domain (tg-lion.net). The www. host serves the docs HTML
# page, not the JSON API.
BASE_URL = os.environ.get("TGLION_BASE_URL", "https://tg-lion.net").rstrip("/")

# Telegram can take a while to deliver a login code (an in-app code is near
# instant, but an SMS fallback can take 1-2 minutes). Poll generously; both
# knobs are overridable from the .env.
CODE_ATTEMPTS = int(os.environ.get("TGLION_CODE_ATTEMPTS", "40"))  # 40 * 5s = ~3.3 min
CODE_DELAY = float(os.environ.get("TGLION_CODE_DELAY", "5"))


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


def _call(
    action: str,
    extra: Optional[dict[str, Any]] = None,
    *,
    raise_on_status: bool = True,
) -> dict[str, Any]:
    """
    Perform one tg-lion API call and return the parsed JSON object.

    `raise_on_status`: when True (default) a `status` other than ok/success is
    turned into a TgLionError. getCode sets this to False because a non-ok
    status there usually just means "Telegram hasn't delivered a code yet",
    which is a normal, retry-able condition rather than a hard failure.
    """
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
    if raise_on_status and status and status not in ("ok", "success"):
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


# A hard credential/config problem (bad key, wrong user id, no permission, no
# balance) will never be fixed by retrying or by trying another number format,
# so we surface those immediately instead of silently polling until timeout.
_HARD_ERROR_RE = re.compile(
    r"api\s*key|apikey|yourid|your\s*id|user\s*id|invalid\s*key|permission|"
    r"unauthor|forbidden|balance|not\s*found|no\s*number|number.*not",
    re.IGNORECASE,
)

# Once we learn which number format tg-lion accepts for a given phone, remember
# it so later polls don't re-probe every format on every call. Keyed by digits.
_GETCODE_FORMAT: dict[str, str] = {}


def _number_variants(number: str) -> list[str]:
    """
    tg-lion is inconsistent about how the `number` must be passed. getNumber
    returns it as '+99800000000', but the docs example URL uses a literal '+'
    (which servers decode to a space), and some backends key on bare digits.

    We therefore try the most robust forms in order:
      1. bare digits            -> '99800000000'   (no +/space/%2B ambiguity)
      2. E.164 with a leading + -> '+99800000000'  (matches getNumber's output)
      3. the raw string as given (in case it carried other formatting)
    """
    raw = str(number).strip()
    digits = re.sub(r"\D", "", raw)
    variants: list[str] = []
    if digits:
        variants.append(digits)
        variants.append("+" + digits)
    if raw and raw not in variants:
        variants.append(raw)
    return variants


def get_code(number: str) -> dict[str, Any]:
    """
    Read the most recent login code Telegram sent to `number`, plus the account's
    current cloud password. Returns the raw tg-lion dict; 'code'/'pass' may be
    empty/absent until Telegram has actually delivered a code (a normal,
    retry-able state — this function does NOT raise for it).

    It DOES raise TgLionError for hard problems (bad API key/user id, no balance,
    unknown number) so the caller stops polling and shows a real reason.

    We probe several `number` formats (see _number_variants) because tg-lion
    matches numbers inconsistently, and cache whichever one it accepts so
    subsequent polls are single-shot.

    NOTE (from the docs): calling getCode also makes the tg-lion bot DISABLE the
    account's 2FA password by default, so after this the account usually has no
    cloud password at login time.
    """
    if not number:
        raise TgLionError("number is required to read a code.")

    digits = re.sub(r"\D", "", str(number))
    known = _GETCODE_FORMAT.get(digits)
    variants = [known] if known else _number_variants(number)

    last_data: dict[str, Any] = {}
    last_msg: Optional[str] = None
    for cand in variants:
        try:
            data = _call("getCode", {"number": cand}, raise_on_status=False)
        except TgLionError as e:
            # Empty body / non-JSON / network hiccup on this variant — remember
            # the reason and try the next format.
            last_msg = str(e)
            continue

        msg = data.get("error") or data.get("message")
        if msg and _HARD_ERROR_RE.search(str(msg)):
            raise TgLionError(f"tg-lion getCode error: {msg}")

        code = str(data.get("code") or "").strip()
        status = str(data.get("status", "")).lower()
        # A valid request echoes the Number / returns status ok even before a
        # code lands, so treat that as the accepted format and lock it in.
        if code or status in ("ok", "success") or data.get("Number"):
            _GETCODE_FORMAT[digits] = cand
            return data

        last_data = data
        last_msg = str(msg) if msg else last_msg

    # No format returned a code or an ok status. If tg-lion gave a message,
    # surface it (so the agent shows the real reason, not a blank timeout).
    if last_msg:
        raise TgLionError(f"tg-lion getCode error: {last_msg}")
    return last_data


def read_code_now(number: str) -> tuple[Optional[str], Optional[str]]:
    """
    Best-effort single read of the current code/password. Never raises for the
    normal 'no code yet' case — returns (None, None) instead. Used to snapshot a
    BASELINE code before we trigger a fresh login, so we can tell a new code
    apart from a stale one left over from a previous step/attempt.
    """
    try:
        data = get_code(number)
    except TgLionError:
        return None, None
    code = str(data.get("code") or "").strip() or None
    passwd = data.get("pass")
    passwd = str(passwd).strip() if passwd not in (None, "") else None
    return code, passwd


def poll_code(
    number: str,
    *,
    attempts: int = CODE_ATTEMPTS,
    delay: float = CODE_DELAY,
    baseline: Optional[str] = None,
) -> tuple[str, Optional[str]]:
    """
    Poll getCode until Telegram delivers a login code, returning (code, password).

    `baseline`: the code value that was already present BEFORE we triggered this
    login. We keep polling until a code that differs from the baseline arrives,
    which prevents us from grabbing a stale code (either left over from a
    previous provisioning attempt, or the code consumed in an earlier step of
    the same run). Snapshot it with read_code_now() right before triggering.
    """
    last_err: Optional[str] = None
    for _ in range(max(1, attempts)):
        try:
            data = get_code(number)
            code = str(data.get("code") or "").strip()
            passwd = data.get("pass")
            passwd = str(passwd).strip() if passwd not in (None, "") else None
            if code and (baseline is None or code != baseline):
                return code, passwd
        except TgLionError as e:
            last_err = str(e)
        time.sleep(delay)
    raise TgLionError(
        last_err
        or f"tg-lion did not deliver a login code for {number} within "
        f"~{int(attempts * delay)}s. Telegram may be slow — the provision job "
        "will retry automatically."
    )
