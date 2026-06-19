# Iamhear — Userbot Agent (Python)

This folder is the **engine** that runs on your **local PC or a VPS**. The website
(the Next.js admin panel) never touches Telegram directly — it only writes **jobs**
into the Neon database. This agent polls those jobs and does the real work:

- Logs into `my.telegram.org`, creates the app **Iamhear / iamheardeveloper**, and
  stores the resulting **api_id / api_hash**.
- Logs the userbot in (code + optional 2FA) and stores the **session string**.
- Joins a channel/group's **live stream (video chat)** in **listen-only** mode.

Because everything goes through the database, the agent works the same whether
it runs on your laptop or a VPS — no ports to open, no NAT/firewall issues.

```
[ Website / Admin panel ]              [ This agent: PC or VPS ]
  writes jobs  ─────────────►  Neon DB  ◄───────────  polls jobs, runs Telegram,
  reads status ◄─────────────  (queue)  ───────────►  writes results back
```

## 1. Requirements

- **Python 3.11 or 3.12** (NOT 3.13/3.14 — `py-tgcalls` is not stable there).
- The same **DATABASE_URL** your website uses (Neon connection string).

## 2. Install

From inside the `LS_Python` folder:

```bash
# (recommended) fresh virtual env with Python 3.11
py -3.11 -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux

# IMPORTANT: remove official pyrogram if present, it conflicts with pyrofork
pip uninstall -y pyrogram tgcrypto

pip install -r requirements.txt
```

## 3. Configure

```bash
copy .env.example .env        # Windows  (cp on macOS/Linux)
```

Open `.env` and paste your Neon connection string into `DATABASE_URL`.
Get it from the v0 project: **Settings (top right) → Vars → DATABASE_URL**.

## 4. Run

```bash
python -m agent.worker
```

You should see:

```
[i] Iamhear agent 'agent-main' starting on YOUR-PC
[i] Polling every 3s. Press Ctrl+C to stop.
```

Leave it running. The website's top bar will now show **the agent is online**.

On a VPS, keep it alive with `screen`, `tmux`, `nohup`, or a `systemd` service.

## 5. How a userbot gets added (the flow you see on the website)

1. **Add account** — type the phone number. → agent logs into my.telegram.org and
   a login code is sent **inside the Telegram app**.
2. **Enter my.telegram.org code** — agent finishes login and creates the
   **Iamhear** app, then stores **api_id / api_hash**.
3. **Verify** — agent uses that api_id/hash to send a **userbot login code** to the phone.
4. **Enter login code** (and **2FA password** if the account has one) — agent stores
   the **session string**. The account is now **logged in / ready**.

Repeat for as many numbers as you want — they all live in the website.

## 6. Joining a live stream

On the website's **Live Stream Join** tab, paste a public/private channel or group
link and click **Join with all userbots**. The agent makes every logged-in userbot
join that chat and then its active live stream in listen-only mode.

---

## Job protocol (for reference)

The website inserts rows into `jobs (type, account_id, payload)`. The agent handles:

| `type`                | payload                          | what the agent does                                   |
| --------------------- | -------------------------------- | ----------------------------------------------------- |
| `create_app`          | `{phone, app_title, short_name}` | send my.telegram.org code; status → `api_code`        |
| `submit_mtproto_code` | `{code}`                         | finish login, create app, store api_id/hash           |
| `send_login_code`     | `{}`                             | send userbot login code to the phone                  |
| `submit_login_code`   | `{code, password?}`              | finish userbot login, store session string            |
| `join_livestream`     | `{target_id, chat_link}`         | join chat + its live stream (listen-only)             |
| `leave_livestream`    | `{target_id}`                    | leave the live stream                                 |

Account `status` values: `new → api_pending → api_code → api_collected →
login_pending → login_code → (login_2fa) → logged_in` (or `failed`).

---

## Important realities / warnings

- **my.telegram.org is not an official API.** This uses HTTP scraping; if Telegram
  changes their HTML, `agent/mtproto_app.py` regexes may need updating.
- **The codes arrive in the Telegram app, not by SMS** — that's why you type them
  in on the website.
- **One Telegram account can usually create only 1–2 apps.**
- **Mass joining from one server IP risks bans.** For many userbots, use **proxies**
  (one per account). You can extend `agent/userbot.py` to pass a proxy to `Client`.
- Running many active calls is **resource heavy** (RAM/CPU/bandwidth) — size your
  VPS accordingly.
