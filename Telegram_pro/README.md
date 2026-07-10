# Telegram_pro (compiled agent)

This folder is the **shippable, source-protected** build of the `LS_Python`
agent. The Python logic lives here only as **compiled, sourceless byte-code**
(`agent/*.pyc`) — there are **no `.py` files**, so the code is not directly
readable or copy-pasteable. It runs exactly like the original.

```
Telegram_pro/
├─ agent/                     # compiled byte-code (sourceless .pyc) — NOT readable
│  ├─ __init__.pyc
│  ├─ db.pyc
│  ├─ mtproto_app.pyc
│  ├─ supervisor.pyc
│  ├─ tglion.pyc
│  ├─ userbot.pyc
│  └─ worker.pyc
├─ build.py                   # recompiles LS_Python/agent -> agent/*.pyc
├─ requirements.txt           # Python dependencies
├─ .env.example               # copy to .env and fill in
├─ run_supervisor.sh          # start supervisor (recommended)
├─ run_worker.sh              # start a single worker
└─ telegram-pro.service.example  # systemd unit for a VPS
```

## Run it

```bash
cd Telegram_pro
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # then fill in DATABASE_URL, API_ID, API_HASH, ...

# recommended: supervisor auto-restarts worker shards
./run_supervisor.sh
# or a single worker
./run_worker.sh
```

You can also run the package directly (same thing the scripts do):

```bash
python -m agent.supervisor
python -m agent.worker
```

## VPS deploy at `/root/tgpro` (24/7 with systemd auto-restart)

Copy the whole `Telegram_pro/` folder to the VPS as `/root/tgpro`, then:

```bash
# 1. install Python 3.12 + build tools (Ubuntu/Debian)
apt update
apt install -y python3.12 python3.12-venv python3.12-dev build-essential git

# 2. dependencies (installed system-wide for python3.12)
cd /root/tgpro
python3.12 -m pip install -r requirements.txt

# 3. RECOMPILE for this VPS's Python (the shipped .pyc may be a different
#    version). Needs the LS_Python source folder next to /root/tgpro,
#    e.g. /root/LS_Python. Skip only if the magic numbers already match.
python3.12 build.py --clean --source /root/LS_Python

# 4. create the .env (fill in DATABASE_URL, TGLION_*, etc.)
cp .env.example .env
nano .env

# 5. install the systemd service (ready-made, no edits needed)
cp /root/tgpro/telegram-pro.service /etc/systemd/system/telegram-pro.service
systemctl daemon-reload
systemctl enable --now telegram-pro     # start now + on every boot
```

Manage / monitor it:

```bash
systemctl status telegram-pro       # is it running?
journalctl -u telegram-pro -f       # live logs
systemctl restart telegram-pro      # restart
systemctl stop telegram-pro         # stop
```

`Restart=always` + `RestartSec=3` + `StartLimitIntervalSec=0` mean the agent
comes back automatically after a crash, an OOM kill, or a server reboot — truly
24/7. The `supervisor` process additionally restarts individual worker shards
inside the service, so a single shard dying never takes the whole agent down.

> If you did **not** install python3.12 system-wide but used a venv, change
> `ExecStart` in the service to your venv python, e.g.
> `/root/tgpro/.venv/bin/python -m agent.supervisor`.

## IMPORTANT — Python version

`.pyc` byte-code is locked to the exact Python version that produced it (the
interpreter "magic number"). The `.pyc` files shipped here were built with the
Python available in the build environment.

**On your VPS you must use Python 3.11 or 3.12** (NOT 3.13 / 3.14 — `py-tgcalls`
is not stable there). If your VPS Python differs from the build Python you will
see an `ImportError` / `bad magic number`. Fix it by recompiling on the VPS:

```bash
# needs the LS_Python source folder available next to Telegram_pro
python3.12 build.py --clean
python3.12 -m agent.supervisor
```

## Rebuilding after a code change

Whenever the source in `LS_Python/agent` changes, regenerate the byte-code:

```bash
python build.py --clean        # uses ../LS_Python by default
python build.py --source /path/to/LS_Python   # custom source location
```

`build.py` compiles with `optimize=2` (docstrings + asserts stripped) and writes
sourceless `.pyc` files, so the distributed folder never contains readable source.

## Security note

Byte-code hides the source and stops casual reading/editing, but it is **not
encryption** — a determined attacker with the matching Python version could
attempt to decompile it. For stronger protection use a native compiler
(Cython → `.so`) or an obfuscator (PyArmor). Ask and this can be set up.
