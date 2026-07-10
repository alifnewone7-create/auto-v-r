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
