import json
from functools import lru_cache
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings read from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="FIELDMERGE_",
        extra="ignore",
    )

    app_name: str = "FieldMerge"
    environment: str = "development"
    database_url: str = "postgresql+asyncpg://fieldmerge:fieldmerge@localhost:5434/fieldmerge"
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:3002"]
    )
    auto_create_schema: bool = True
    sql_echo: bool = False
    public_demo_mode: bool = False
    max_pending_operations: int = Field(default=200, ge=1, le=2_000)
    max_log_operations: int = Field(default=10_000, ge=4, le=100_000)
    database_pool_size: int = Field(default=5, ge=1, le=20)
    database_max_overflow: int = Field(default=2, ge=0, le=20)
    database_pool_timeout_seconds: int = Field(default=30, ge=1, le=120)
    database_pool_recycle_seconds: int = Field(default=300, ge=30, le=3_600)

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            if value.lstrip().startswith("["):
                decoded = json.loads(value)
                if not isinstance(decoded, list):
                    raise ValueError("CORS origins JSON must be an array")
                return decoded
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
