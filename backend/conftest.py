"""Global pytest bootstrap for backend tests."""

import os


os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-bot-token")
os.environ.setdefault("YAP_WORKER_SECRET", "test-yap-secret")
