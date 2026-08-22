from __future__ import annotations

import argparse
import os
import re
import select
import sys
import termios
import threading
import tty
import unicodedata
from pathlib import Path
from typing import Callable

from .agent import Agent, DEFAULT_MODEL, Session, TOOL_DEFINITIONS, format_tool_event, format_usage, load_project_instructions, load_skills
from .mcp import display_tool_name, load_mcp_configs, load_mcp_tools, split_mcp_aliases

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
    def run(self, agent: Agent, operation: Callable[[], str]) -> str:
        if not self.tty: return operation()
        result, done = [], threading.Event()
        def work():
            try: result.append((operation(), None))
            except BaseException as error: result.append((None, error))
            done.set()
        threading.Thread(target=work).start()
        while not done.wait(0.05):
            ready, _, _ = select.select([self.fd], [], [], 0)
            if not ready: continue
            char = os.read(self.fd, 1)
            if char == b"\x1b" and self.escape_sequence() == b"":
                print("\n\x1b[33mAborting...\x1b[0m"); agent.abort()
            if char == b"\x03": agent.abort(); done.wait(); raise KeyboardInterrupt
        answer, error = result[0]
        if error: raise error
        return answer


def run_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False); parser.add_argument("--session"); parser.add_argument("--skill", action="append", default=[]); parser.add_argument("--mcp", action="append", default=[]); parser.add_argument("prompt", nargs="*")
    args = parser.parse_args(argv); aliases = split_mcp_aliases(args.mcp); configs = load_mcp_configs(aliases)
    loaded_mcp = []
    try:
        for config in configs:
            try: loaded = load_mcp_tools(config)
            except (ValueError, RuntimeError, OSError, TimeoutError) as error: raise RuntimeError(f"MCP {config.alias} failed: {error}") from error
            loaded_mcp.append(loaded)
            print(f"MCP {config.alias}: connected ({loaded.protocol_version}, {len(loaded.tools)} tools)")
        skills = load_skills(args.skill); session = Session.open(args.session) if args.session else Session.create()
        tools = [*TOOL_DEFINITIONS, *(tool for loaded in loaded_mcp for tool in loaded.tools)]
        agent = Agent(skills, session, load_project_instructions(), tools=tools)
        if args.session: agent.resume_session()
        def show_tool(event):
            shown = {**event, "name": display_tool_name(event["name"])}
            print(f"\x1b[{'33' if event['phase'] == 'start' else '2'}m{format_tool_event(shown)}\x1b[0m")
        agent.on_tool = show_tool
        restored = "\nrestored: yes" if args.session else ""
        names = ", ".join(display_tool_name(tool["function"]["name"]) for tool in tools) or "(none)"
        print(f"\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nmodel: {os.getenv('TINY_MODEL') or DEFAULT_MODEL}\nsession: {session.id}\npath: {session.path}\ntools: {names}\nmcp: {', '.join(aliases) or '(none)'}{restored}")
        resume = lambda: print(f"\nResume: tiny-py --session {session.id}")
        try:
            with Terminal() as terminal:
                if args.prompt:
                    print(f"\n{terminal.run(agent, lambda: agent.run_agent_loop(' '.join(args.prompt)))}\n\x1b[2m{format_usage(agent.usage)}\x1b[0m"); resume(); return 0
                print("Esc aborts the active operation; Ctrl+C exits.\n/compact  /skill:name  /exit")
                while True:
                    text = terminal.readline("\x1b[32m›\x1b[0m ")
                    if not text: continue
                    if text == "/exit": break
                    if text == "/compact": answer = terminal.run(agent, agent.compact)
                    elif text.startswith("/skill:"):
                        name, _, request = text[7:].partition(" "); skill = next((item for item in skills if item["name"] == name), None)
                        if not skill: print(f"Unknown skill: {name}"); continue
                        answer = terminal.run(agent, lambda: agent.run_agent_loop(f"{Path(skill['path']).read_text(encoding='utf-8')}\n\nUser: {request}"))
                    else: answer = terminal.run(agent, lambda: agent.run_agent_loop(text))
                    print(f"\x1b[36m{answer}\x1b[0m\n\x1b[2m{format_usage(agent.usage)}\x1b[0m")
        except KeyboardInterrupt:
            pass
        resume(); return 0
    finally:
        for loaded in reversed(loaded_mcp):
            try: loaded.close()
            except Exception: pass


def main() -> None:
    try: raise SystemExit(run_cli())
    except (ValueError, RuntimeError, OSError) as error: print(error, file=sys.stderr); raise SystemExit(1)
