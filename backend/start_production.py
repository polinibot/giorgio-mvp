import os
import signal
import subprocess
import sys
import time


def start_process(args, env=None):
    return subprocess.Popen(args, env=env)


def run_migrations_once():
    """Run schema creation/migrations a single time before spawning the API and
    bot, so the two child processes never run destructive DDL concurrently."""
    from database_sqlite import create_tables

    create_tables()


def stop_process(proc):
    if proc.poll() is not None:
        return
    try:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def main():
    port = os.getenv("PORT", "8000")

    # Migrate once, then tell the children to skip migrations.
    run_migrations_once()
    child_env = os.environ.copy()
    child_env["GIORGIO_SKIP_MIGRATIONS"] = "1"

    processes = [
        start_process([sys.executable, "bot.py"], env=child_env),
        start_process([
            sys.executable,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "0.0.0.0",
            "--port",
            port,
        ], env=child_env),
    ]

    try:
        while True:
            for proc in processes:
                code = proc.poll()
                if code is not None:
                    for other in processes:
                        if other is not proc:
                            stop_process(other)
                    return code or 1
            time.sleep(1)
    except KeyboardInterrupt:
        for proc in processes:
            stop_process(proc)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
