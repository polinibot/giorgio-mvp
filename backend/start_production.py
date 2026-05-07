import os
import signal
import subprocess
import sys
import time


def start_process(args):
    return subprocess.Popen(args)


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
    processes = [
        start_process([sys.executable, "bot.py"]),
        start_process([
            sys.executable,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "0.0.0.0",
            "--port",
            port,
        ]),
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
