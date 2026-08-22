from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO

from .session_reducer import reduce_session

DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731"
ROOT = Path.cwd().resolve()
_WRITERS: set[Path] = set()
_WRITERS_LOCK = threading.Lock()


def uuid7(now_ms: int | None = None) -> str:
    value = bytearray(secrets.token_bytes(16)); value[:6] = (now_ms or time.time_ns() // 1_000_000).to_bytes(6, "big")
    value[6] = value[6] & 0x0F | 0x70; value[8] = value[8] & 0x3F | 0x80
    h = value.hex(); return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def environment_identity(cwd: Path = ROOT) -> str:
    override = os.getenv("TINY_AGENT_ENVIRONMENT_IDENTITY", "").strip()
    return override or str(cwd.resolve())


def _open_nofollow(path: Path, flags: int, mode: int = 0o600) -> int:
    return os.open(path, flags | getattr(os, "O_NOFOLLOW", 0), mode)


class Session:
    def __init__(self, session_id: str, path: Path, file: BinaryIO, data: bytes, state: dict, next_seq: int = 1):
        self.id, self.path, self.file, self.data = session_id, path, file, data
        self.state, self.next_seq, self.lock, self.closed = state, next_seq, threading.Lock(), False

    @classmethod
    def create(cls, cwd: Path = ROOT, now: datetime | None = None) -> Session:
        now = now or datetime.now(timezone.utc)
        session_id = uuid7(int(now.timestamp() * 1000))
        directory = cwd / ".tiny-agent/sessions"
        directory.mkdir(parents=True, exist_ok=True)
        directory = directory.resolve(strict=True)
        stamp = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        path = directory / f"{stamp.replace(':', '-').replace('.', '-')}_{session_id}.jsonl"
        header = {
            "kind": "header", "version": 2, "id": session_id,
            "createdAt": int(now.timestamp() * 1000), "cwd": str(cwd.resolve()),
            "provider": "openrouter", "model": os.getenv("TINY_MODEL") or DEFAULT_MODEL,
            "environmentIdentity": environment_identity(cwd),
        }
        data = (json.dumps(header, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        fd = _open_nofollow(path, os.O_RDWR | os.O_CREAT | os.O_EXCL)
        file = os.fdopen(fd, "r+b", buffering=0)
        try:
            file.write(data)
            os.fchmod(fd, 0o600)
            state = reduce_session(data)
            with _WRITERS_LOCK:
                _WRITERS.add(path)
            return cls(session_id, path, file, data, state)
        except Exception:
            file.close()
            path.unlink(missing_ok=True)
            raise

    @classmethod
    def open(cls, session_id: str, cwd: Path = ROOT) -> Session:
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", session_id, re.I):
            raise ValueError(f"Invalid session ID: {session_id}")
        directory = (cwd / ".tiny-agent/sessions").resolve(strict=True)
        matches = [entry for entry in os.scandir(directory) if entry.is_file(follow_symlinks=False) and entry.name.endswith(f"_{session_id}.jsonl")]
        if len(matches) != 1:
            raise ValueError(f"{'Duplicate session ID' if matches else 'Session not found'}: {session_id}")
        path = Path(matches[0].path)
        if path.parent.resolve(strict=True) != directory:
            raise ValueError(f"Unsafe session path: {session_id}")
        with _WRITERS_LOCK:
            if path in _WRITERS:
                raise ValueError(f"Session is already open for writing: {session_id}")
        fd = _open_nofollow(path, os.O_RDWR | os.O_APPEND)
        file = os.fdopen(fd, "r+b", buffering=0)
        try:
            file.seek(0); data = file.read(); state = reduce_session(data)
            if state["header"]["id"] != session_id:
                raise ValueError("session filename does not match header")
            repaired = state["repairedLength"]
            if repaired != len(data):
                file.truncate(repaired); data = data[:repaired]
            os.fchmod(fd, 0o600); file.seek(0, os.SEEK_END)
            with _WRITERS_LOCK:
                if path in _WRITERS:
                    raise ValueError(f"Session is already open for writing: {session_id}")
                _WRITERS.add(path)
            return cls(session_id, path, file, data, reduce_session(data), _next_seq(data))
        except Exception:
            file.close()
            raise

    def load(self) -> dict:
        with self.lock:
            if self.closed: raise ValueError("Session is closed")
            return self.state

    def append(self, *facts: dict) -> list[dict]:
        if not facts: raise ValueError("Session transaction must not be empty")
        with self.lock:
            if self.closed: raise ValueError("Session is closed")
            return self._append_locked(facts)

    def request_abort(self, operation_id: str, cancelled: threading.Event, fact: dict) -> bool:
        with self.lock:
            if self.closed: raise ValueError("Session is closed")
            operation = self.state["operation"]
            if operation["kind"] == "idle" or operation.get("operationId") != operation_id or operation.get("abortRequested"):
                return False
            record = fact.get("record", {})
            phase = record.get("phase")
            if phase in ("model", "compact") and operation.get("step", {}).get("status") != "attempting":
                return False
            if phase == "tool" and not any(tool["status"] == "pending" and tool["toolCallId"] == record.get("toolCallId") for tool in operation.get("toolCalls", [])):
                return False
            self._append_locked((fact,))
            cancelled.set()
            return True

    def append_aborted_attempt(self, operation_id: str, cancelled: threading.Event, failure: dict, usage: dict) -> list[dict]:
        with self.lock:
            if self.closed: raise ValueError("Session is closed")
            operation = self.state["operation"]
            if operation["kind"] == "idle" or operation.get("operationId") != operation_id or not (cancelled.is_set() or operation.get("abortRequested")):
                raise ValueError("Operation is not aborted")
            return self._append_locked((failure, usage))

    def append_if_active(self, operation_id: str, cancelled: threading.Event, *facts: dict) -> list[dict] | None:
        if not facts: raise ValueError("Session transaction must not be empty")
        with self.lock:
            if self.closed: raise ValueError("Session is closed")
            operation = self.state["operation"]
            if cancelled.is_set() or operation["kind"] == "idle" or operation.get("operationId") != operation_id or operation.get("abortRequested"):
                return None
            return self._append_locked(facts)

    def _append_locked(self, facts: tuple[dict, ...]) -> list[dict]:
        timestamp = time.time_ns() // 1_000_000
        committed = [{**fact, "seq": self.next_seq + index, "id": fact.get("id", uuid7()), "timestamp": timestamp} for index, fact in enumerate(facts)]
        value: object = committed[0] if len(committed) == 1 else committed
        line = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        candidate = self.data + line
        state = reduce_session(candidate)
        self.file.write(line)
        self.data, self.state, self.next_seq = candidate, state, self.next_seq + len(committed)
        return committed

    def close(self) -> None:
        with self.lock:
            if self.closed: return
            self.closed = True
            try: self.file.close()
            finally:
                with _WRITERS_LOCK: _WRITERS.discard(self.path)


def _next_seq(data: bytes) -> int:
    last = 0
    for line in data.decode("utf-8").splitlines()[1:]:
        value = json.loads(line); facts = value if isinstance(value, list) else [value]
        if facts: last = facts[-1]["seq"]
    return last + 1
