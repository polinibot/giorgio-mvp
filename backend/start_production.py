import os
import signal
import subprocess
import sys
import time
import logging


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(levelname)s:%(name)s:%(message)s",
)
logger = logging.getLogger(__name__)

DEFAULT_MIGRATION_TIMEOUT_SECONDS = 60
MIGRATION_TIMEOUT_ENV = "GIORGIO_MIGRATION_TIMEOUT_SECONDS"


def start_process(args, env=None):
    return subprocess.Popen(args, env=env)


def _build_child_env():
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    return env


def _migration_timeout_seconds() -> int:
    raw_value = str(os.getenv(MIGRATION_TIMEOUT_ENV, DEFAULT_MIGRATION_TIMEOUT_SECONDS)).strip()
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        logger.warning("Invalid %s=%s, using default %s", MIGRATION_TIMEOUT_ENV, raw_value, DEFAULT_MIGRATION_TIMEOUT_SECONDS)
        return DEFAULT_MIGRATION_TIMEOUT_SECONDS


def run_migrations_once():
    """Run schema creation/migrations before spawning the API and bot.

    Migrations run in a dedicated subprocess so startup logs stay visible and a
    hung DB connection cannot block the whole container forever.
    """
    env = _build_child_env()
    timeout_seconds = _migration_timeout_seconds()
    migration_cmd = [
        sys.executable,
        "-c",
        "from database_sqlite import create_tables; create_tables()",
    ]

    logger.info("Starting database migrations before boot")
    proc = start_process(migration_cmd, env=env)

    try:
        proc.wait(timeout=None if timeout_seconds <= 0 else timeout_seconds)
    except subprocess.TimeoutExpired:
        logger.error(
            "Database migrations exceeded %s seconds. Continuing startup with GIORGIO_SKIP_MIGRATIONS=1 so /health can come up.",
            timeout_seconds,
        )
        stop_process(proc)
        return False

    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, migration_cmd)

    logger.info("Database migrations completed")
    return True


def stop_process(proc):
    if proc.poll() is not None:
        return
    try:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def main():
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    port = os.getenv("PORT", "8000")

    # Migrate once, then tell the children to skip migrations.
    migrations_completed = run_migrations_once()
    child_env = _build_child_env()
    child_env["GIORGIO_SKIP_MIGRATIONS"] = "1"
    if not migrations_completed:
        child_env["GIORGIO_MIGRATIONS_TIMED_OUT"] = "1"

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
