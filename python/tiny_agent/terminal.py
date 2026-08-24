import asyncio
import os
import re
import select
import sys
import termios
import tty
import unicodedata
from typing import Awaitable, Callable

from .agent import Agent


class Terminal:
    def __init__(self): self.fd = sys.stdin.fileno(); self.tty = sys.stdin.isatty(); self.old = termios.tcgetattr(self.fd) if self.tty else None
    def escape_sequence(self) -> bytes | None:
        ready, _, _ = select.select([self.fd], [], [], 0.02)
        if not ready: return b""
        char = os.read(self.fd, 1)
        if char not in (b"[", b"O"): return None
        while True:
            ready, _, _ = select.select([self.fd], [], [], 0.02)
            if not ready: return None
            char = os.read(self.fd, 1)
            if b"@" <= char <= b"~": return char
    @staticmethod
    def display_position(text: str | list[str], columns: int) -> tuple[int, int]:
        offset = 0
        for char in text:
            cell = 0 if unicodedata.combining(char) or unicodedata.category(char) in ("Cf", "Me") else 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
            if cell == 2 and offset % columns == columns - 1: offset += 1
            offset += cell
        return divmod(offset, columns)
    def redraw(self, prompt: str, line: list[str], cursor: int, old_row: int) -> int:
        try: columns = os.get_terminal_size(self.fd).columns
        except OSError: columns = 80
        clean_prompt = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", prompt)
        if old_row: print(f"\x1b[{old_row}A", end="")
        print(f"\r\x1b[J{prompt}{''.join(line)}", end="")
        end_row, end_column = self.display_position(clean_prompt + "".join(line), columns)
        target_row, target_column = self.display_position(clean_prompt + "".join(line[:cursor]), columns)
        if end_column == 0: print(" ", end="")
        if end_row > target_row: print(f"\x1b[{end_row - target_row}A", end="")
        print(f"\r\x1b[{target_column}C" if target_column else "\r", end="", flush=True)
        return target_row
    def __enter__(self):
        if self.tty:
            tty.setraw(self.fd)
            current = termios.tcgetattr(self.fd); current[1] |= termios.OPOST | termios.ONLCR; termios.tcsetattr(self.fd, termios.TCSANOW, current)
        return self
    def __exit__(self, *_):
        if self.old: termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old)
    def readline(self, prompt: str) -> str:
        if not self.tty: return input(prompt).strip()
        print(prompt, end="", flush=True); line: list[str] = []; cursor = row = 0; pending = bytearray()
        while True:
            char = os.read(self.fd, 1)
            if char == b"\x03": raise KeyboardInterrupt
            if char == b"\x1b":
                key = self.escape_sequence()
                if key == b"D" and cursor:
                    cursor -= 1
                    while cursor and (unicodedata.combining(line[cursor]) or unicodedata.category(line[cursor]) in ("Cf", "Me")): cursor -= 1
                    row = self.redraw(prompt, line, cursor, row)
                elif key == b"C" and cursor < len(line):
                    cursor += 1
                    while cursor < len(line) and (unicodedata.combining(line[cursor]) or unicodedata.category(line[cursor]) in ("Cf", "Me")): cursor += 1
                    row = self.redraw(prompt, line, cursor, row)
                continue
            if char in (b"\r", b"\n"): print(); return "".join(line).strip()
            if char in (b"\x08", b"\x7f"):
                if cursor:
                    start = cursor - 1
                    while start and (unicodedata.combining(line[start]) or unicodedata.category(line[start]) in ("Cf", "Me")): start -= 1
                    del line[start:cursor]; cursor = start; row = self.redraw(prompt, line, cursor, row)
                continue
            if char >= b" ":
                pending += char
                try: text = pending.decode()
                except UnicodeDecodeError: continue
                line[cursor:cursor] = text; cursor += len(text); pending.clear(); row = self.redraw(prompt, line, cursor, row)
    async def run(self, agent: Agent, operation: Callable[[], Awaitable[str]]) -> str:
        task = asyncio.create_task(operation())
        if not self.tty: return await task
        while not task.done():
            await asyncio.sleep(0.05)
            ready, _, _ = select.select([self.fd], [], [], 0)
            if not ready: continue
            char = os.read(self.fd, 1)
            if char == b"\x1b" and self.escape_sequence() == b"":
                print("\n\x1b[33mAborting...\x1b[0m"); agent.abort()
            if char == b"\x03": agent.abort(); await asyncio.gather(task, return_exceptions=True); raise KeyboardInterrupt
        return await task
