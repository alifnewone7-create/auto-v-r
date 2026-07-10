# tgpro — VPS Setup Guide (LS_Python source)

এই এজেন্টটা VPS-এ `/root/tgpro` ফোল্ডারে সোর্স (LS_Python) হিসেবে চলে, `systemd`
দিয়ে 24/7 on থাকে এবং crash/reboot হলে auto-restart হয়।

> ⚠️ **Python version:** অবশ্যই **Python 3.11 বা 3.12** ব্যবহার করবে।
> 3.13 / 3.14-তে `py-tgcalls` অস্থির — livestream drop / crash করে।

---

## ১. ফাইল আপলোড

`LS_Python` ফোল্ডারের সব ফাইল VPS-এ `/root/tgpro`-তে রাখো। ফাইনালি এমন থাকবে:

```
/root/tgpro/agent/...
/root/tgpro/requirements.txt
/root/tgpro/tgpro.service
/root/tgpro/.env.vps.example
```

---

## ২. Python 3.12 + build tools ইনস্টল (Ubuntu/Debian)

```bash
apt update
apt install -y python3.12 python3.12-venv python3.12-dev build-essential git
```

---

## ৩. virtualenv বানাও + dependencies ইনস্টল

> Debian সিস্টেম python-এ সরাসরি `pip install` করলে `externally-managed-environment`
> (PEP 668) error আসে। তাই **সবসময় venv** ব্যবহার করবে।

```bash
cd /root/tgpro
python3.12 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip
pip uninstall -y pyrogram tgcrypto      # official pyrogram থাকলে সরাও (conflict করে)
pip install -r requirements.txt
```

ইনস্টল ঠিক হলো কিনা যাচাই করো:

```bash
/root/tgpro/.venv/bin/python -c "import dotenv, pyrogram, asyncpg, pytgcalls; print('all ok')"
```

`all ok` দেখালে পরের ধাপে যাও।

---

## ৪. `.env` তৈরি

```bash
cd /root/tgpro
cp .env.vps.example .env
nano .env
```

কমপক্ষে যা ভরতে হবে:

- **`DATABASE_URL`** — v0 project → Settings (উপরে ডানে) → **Vars** → `DATABASE_URL`
  (শেষে `?sslmode=require` থাকতে হবে)। ওয়েবসাইট যে Neon DB ব্যবহার করে, ঠিক সেটাই।
- **`TGLION_*`** — tg-lion দিয়ে নম্বর কেনা/provision করলে লাগবে
  (`TGLION_API_KEY`, `TGLION_USER_ID`, `TGLION_NEW_2FA_PASSWORD`)।

VPS-এর core অনুযায়ী `AGENT_WORKERS` টিউন করো (4-core → 4, 8-core → 6-8)।
প্রোফাইল rate limit বাঁচাতে `AGENT_PROFILE_CONCURRENCY` কখনো 3-এর বেশি নয়।

---

## ৫. systemd service ইনস্টল ও চালু

service ফাইলটা রেডি করা আছে (`ExecStart` venv python-এ পয়েন্ট করা), শুধু কপি করো:

```bash
cp /root/tgpro/tgpro.service /etc/systemd/system/tgpro.service
systemctl daemon-reload
systemctl enable --now tgpro       # এখনই চালু + প্রতি boot-এ auto-start
```

---

## ৬. মনিটর / কন্ট্রোল

```bash
systemctl status tgpro       # চলছে কিনা (active running)
journalctl -u tgpro -f       # লাইভ লগ
systemctl restart tgpro      # রিস্টার্ট
systemctl stop tgpro         # বন্ধ
```

---

## Auto-restart কীভাবে গ্যারান্টি করা আছে

- `Restart=always` + `RestartSec=3` → crash / OOM / kill হলে ৩ সেকেন্ডে ফিরে আসে।
- `StartLimitIntervalSec=0` → বারবার crash হলেও systemd কখনো হাল ছাড়ে না।
- `systemctl enable` → সার্ভার reboot হলেও নিজে চালু হয়।
- ভেতরে `agent.supervisor` প্রতিটা worker shard আলাদাভাবে auto-restart করে —
  একটা shard মরলে পুরো এজেন্ট পড়ে না। ফলে সত্যিকারের 24/7।

---

## গুরুত্বপূর্ণ নিয়ম

**যে python-এ deps ইনস্টল করবে, service-ও ঠিক সেই python চালাবে।**
এখানে দুটোই `/root/tgpro/.venv/bin/python` — মিলে আছে। মিল না থাকলে shard গুলো
`ModuleNotFoundError` দিয়ে crash করবে।

---

## Troubleshooting

| সমস্যা | কারণ ও সমাধান |
|--------|----------------|
| `ModuleNotFoundError: No module named 'dotenv'` (বা অন্য module) | deps ভুল python-এ বসেছে। ধাপ ৩ venv-এ আবার করো, নিশ্চিত করো `ExecStart` = `/root/tgpro/.venv/bin/python`। |
| `externally-managed-environment` (PEP 668) | সিস্টেম python-এ ইনস্টল করছ। venv activate করে (`source .venv/bin/activate`) তারপর ইনস্টল করো। |
| `bad magic number` | ভুল Python version। 3.12 দিয়ে venv বানাও, `.pyc` cache মুছতে `find . -name '__pycache__' -type d -exec rm -rf {} +`। |
| shard বারবার restart হচ্ছে | `journalctl -u tgpro -f` দেখো — সাধারণত missing dep বা ভুল `DATABASE_URL`। |
| এজেন্ট online হচ্ছে না | `DATABASE_URL` ঠিক আছে কিনা দেখো; `systemctl status tgpro` active কিনা দেখো। |

---

## সার্ভিস আপডেট করলে

কোড বা service ফাইল বদলালে:

```bash
# কোড আপডেট করলে
systemctl restart tgpro

# tgpro.service ফাইল এডিট করলে
cp /root/tgpro/tgpro.service /etc/systemd/system/tgpro.service
systemctl daemon-reload
systemctl restart tgpro
```
