from __future__ import annotations

import json
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .session_reducer import reduce_session

DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731"
ROOT = Path.cwd().resolve()


def uuid7(now_ms: int | None = None) -> str:
    value = bytearray(secrets.token_bytes(16)); value[:6] = (now_ms or time.time_ns() // 1_000_000).to_bytes(6, "big")
    value[6] = value[6] & 0x0F | 0x70; value[8] = value[8] & 0x3F | 0x80
    h = value.hex(); return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def environment_identity(cwd: Path = ROOT) -> str:
    return os.getenv("TINY_AGENT_ENVIRONMENT_IDENTITY") or str(cwd.resolve())


class Session:
    def __init__(self, session_id: str, path: Path, next_seq: int = 1):
        self.id, self.path, self.next_seq, self.lock = session_id, path, next_seq, threading.Lock()

    @classmethod
    def create(cls, cwd: Path = ROOT, now: datetime | None = None) -> Session:
        now = now or datetime.now(timezone.utc)
        session_id = uuid7(int(now.timestamp() * 1000))
        directory = cwd / ".tiny-agent/sessions"
        directory.mkdir(parents=True, exist_ok=True)
        stamp = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        path = directory / f"{stamp.replace(':', '-').replace('.', '-')}_{session_id}.jsonl"
        header = {
            "kind": "header", "version": 2, "id": session_id,
            "createdAt": int(now.timestamp() * 1000), "cwd": str(cwd.resolve()),
            "provider": "openrouter", "model": os.getenv("TINY_MODEL") or DEFAULT_MODEL,
            "environmentIdentity": environment_identity(cwd),
        }
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as file:
            file.write(json.dumps(header, ensure_ascii=False, separators=(",", ":")) + "\n")
        return cls(session_id, path)

    @classmethod
    def open(cls, session_id: str, cwd: Path = ROOT) -> Session:
        import re
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", session_id, re.I):
            raise ValueError(f"Invalid session ID: {session_id}")
        matches = list((cwd / ".tiny-agent/sessions").glob(f"*_{session_id}.jsonl"))
        if len(matches) != 1:
            raise ValueError(f"{'Duplicate session ID' if matches else 'Session not found'}: {session_id}")
        path = matches[0]
        data = path.read_bytes()
        state = reduce_session(data)
        repaired = state["repairedLength"]
        if repaired != len(data):
            with path.open("r+b") as file: file.truncate(repaired)
        return cls(session_id, path, _next_seq(data[:repaired]))

    def load(self) -> dict:
        return reduce_session(self.path.read_bytes())

    def append(self, *facts: dict) -> list[dict]:
        if not facts: return []
        with self.lock:
            timestamp = time.time_ns() // 1_000_000
            committed = []
            for fact in facts:
                committed.append({**fact, "seq": self.next_seq, "id": fact.get("id", uuid7()), "timestamp": timestamp})
                self.next_seq += 1
            line: object = committed[0] if len(committed) == 1 else committed
            with self.path.open("a", encoding="utf-8", newline="\n") as file:
                file.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")
            return committed

    def close(self) -> None:
        pass


def _next_seq(data: bytes) -> int:
    lines = data.decode("utf-8").splitlines()[1:]
    last = 0
    for line in lines:
        value = json.loads(line)
        facts = value if isinstance(value, list) else [value]
        if facts: last = facts[-1]["seq"]
    return last + 1
