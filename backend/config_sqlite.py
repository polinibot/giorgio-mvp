from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    telegram_bot_token: str
    database_url: str = "sqlite:///./giorgio.db"  # Default SQLite
    whitelist_telegram_ids: List[int]
    ocr_confidence_threshold: float = 0.6
    secret_key: str

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"

    @property
    def webhook_url(self) -> str:
        return f"https://api.telegram.org/bot{self.telegram_bot_token}"


settings = Settings()
