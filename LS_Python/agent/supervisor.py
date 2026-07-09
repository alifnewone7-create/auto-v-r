"""
Shard supervisor — spawn and keep alive N worker processes.

WHY THIS EXISTS
---------------
Every userbot holds a persistent WebRTC live-stream connection. When hundreds of
those live in ONE process/event loop, a momentary stall starves the native
keepalives and Telegram evicts many peers at once — the "join then everyone drops
after 2-3 min" bug. The cure is horizontal: run several worker PROCESSES, each on
its own CPU core with its own event loop, and give each one only a SLICE of the
userbots. This module launches and babysits those processes.

HOW SHARDING WORKS
------------------
Each account has a stable integer id. Shard `i` (of `N`) owns an account when
`account_id % N == i`, so every bot lives in exactly one process. Per-account jobs
are routed by that same rule in `db.claim_next_jobs`. Fan-out actions
(view/react/leave-all) are enqueued once and shard 0 expands them into one copy
per shard, so they still reach every bot. All of that logic lives in the worker;
this supervisor only owns process lifecycle.

USAGE
-----
    # spawns LS_WORKER_SHARDS processes (default 7)
    python -m agent.supervisor

Set the shard count in .env:
    LS_WORKER_SHARDS=7
    LS_SOFT_MAX_PER_SHARD=70

Single-process mode is still available with no supervisor:
    python -m agent.worker        # SHARD_COUNT defaults to 1

Keep the supervisor alive on a VPS with screen/tmux/nohup or a systemd service —
exactly like you already do for the worker. If any shard crashes, the supervisor
restarts it automatically (with a short backoff).
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time

# Number of worker processes to run. On an 8-core VPS, 7 leaves one core for the
# OS + this supervisor + the DB driver. Each shard should stay under
# LS_SOFT_MAX_PER_SHARD bots; the worker logs a warning if it goes over.
SHARD_COUNT = max(1, int(os.environ.get("LS_WORKER_SHARDS", "7")))

# If a shard exits, wait this long before restarting it so a crash-loop can't
# hammer Telegram / the DB. Restarts are logged so you can spot a bad shard.
RESTART_BACKOFF_SECONDS = max(1.0, float(os.environ.get("LS_SHARD_RESTART_BACKOFF", "5")))

# How often the supervisor checks each child's health.
POLL_SECONDS = 2.0


class Shard:
    """One supervised worker process for a single shard index."""

    def __init__(self, index: int, total: int) -> None:
        self.index = index
        self.total = total
        self.proc: subprocess.Popen | None = None
        self.next_start_at = 0.0  # monotonic time we may (re)start it

    def _env(self) -> dict[str, str]:
        # Inherit the real environment (DATABASE_URL, tuning knobs, etc.) and
        # inject this shard's identity. LS_SHARD_INDEX + LS_WORKER_SHARDS tell the
        # worker which accounts to own.
        env = dict(os.environ)
        env["LS_WORKER_SHARDS"] = str(self.total)
        env["LS_SHARD_INDEX"] = str(self.index)
        # Force line-buffered child output so shard logs stream through promptly.
        env["PYTHONUNBUFFERED"] = "1"
        return env

    def start(self) -> None:
        """Launch the worker process for this shard."""
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "agent.worker"],
            env=self._env(),
        )
        print(
            f"[supervisor] started shard {self.index + 1}/{self.total} "
            f"(pid {self.proc.pid})",
            flush=True,
        )

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def ensure_running(self, now: float) -> None:
        """(Re)start the shard if it isn't running and its backoff has elapsed."""
        if self.is_alive():
            return
        if self.proc is not None:
            code = self.proc.returncode
            print(
                f"[supervisor] shard {self.index + 1}/{self.total} exited "
                f"(code {code}); restarting in {RESTART_BACKOFF_SECONDS:.0f}s",
                flush=True,
            )
            self.proc = None
            self.next_start_at = now + RESTART_BACKOFF_SECONDS
        if now >= self.next_start_at:
            self.start()

    def terminate(self) -> None:
        """Ask the shard to stop gracefully."""
        if self.is_alive():
            try:
                self.proc.terminate()  # type: ignore[union-attr]
            except Exception:
                pass


def main() -> None:
    if SHARD_COUNT <= 1:
        # No point supervising a single process — just run the worker inline so
        # behavior is identical to `python -m agent.worker`.
        print("[supervisor] LS_WORKER_SHARDS<=1; running a single worker inline.", flush=True)
        from agent import worker  # local import keeps startup light

        import asyncio

        try:
            asyncio.run(worker.main())
        except KeyboardInterrupt:
            pass
        return

    print(f"[supervisor] launching {SHARD_COUNT} worker shard(s)...", flush=True)
    shards = [Shard(i, SHARD_COUNT) for i in range(SHARD_COUNT)]

    stopping = False

    def _handle_stop(_signum, _frame) -> None:  # noqa: ANN001
        nonlocal stopping
        stopping = True
        print("\n[supervisor] stopping all shards...", flush=True)
        for s in shards:
            s.terminate()

    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)

    # Initial staggered launch: bringing 7 processes up at the exact same instant
    # would create a synchronized burst of logins/joins. A tiny stagger smooths it.
    for s in shards:
        s.start()
        time.sleep(0.5)

    try:
        while not stopping:
            now = time.monotonic()
            for s in shards:
                if not stopping:
                    s.ensure_running(now)
            time.sleep(POLL_SECONDS)
    finally:
        # Give children a moment to exit gracefully, then hard-kill stragglers.
        deadline = time.monotonic() + 10
        for s in shards:
            s.terminate()
        while time.monotonic() < deadline and any(s.is_alive() for s in shards):
            time.sleep(0.3)
        for s in shards:
            if s.is_alive():
                try:
                    s.proc.kill()  # type: ignore[union-attr]
                except Exception:
                    pass
        print("[supervisor] all shards stopped. Bye!", flush=True)


if __name__ == "__main__":
    main()
