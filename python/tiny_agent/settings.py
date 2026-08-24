import os
from pathlib import Path

from pydantic import PrivateAttr, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    openrouter_api_key: SecretStr | None = None
    tiny_model: str = DEFAULT_MODEL
    tiny_mcp_config: Path | None = None
    tiny_agent_environment_identity: str = ""
    _environment: dict[str, str] = PrivateAttr(default_factory=lambda: dict(os.environ))

    @property
    def environment(self) -> dict[str, str]: return self._environment
