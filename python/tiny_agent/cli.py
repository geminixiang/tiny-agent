from __future__ import annotations

import argparse
import asyncio
import sys
import termios
import tty
from pathlib import Path

from .agent import Agent, TOOL_DEFINITIONS, format_tool_event, format_usage, load_project_instructions, load_skills
from .session import Session
from .mcp import display_tool_name, load_mcp_configs, load_mcp_tools, split_mcp_aliases, split_names
from .settings import Settings
from .terminal import Terminal

PLUGIN_NAMES = tuple(tool["function"]["name"] for tool in TOOL_DEFINITIONS)


async def run_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--session")
    parser.add_argument("--skill", action="append", default=[])
    parser.add_argument("--plugin", action="append", default=[])
    parser.add_argument("--mcp", action="append", default=[])
    parser.add_argument("prompt", nargs="*")
    args = parser.parse_args(argv)
    selected_plugins = split_names(args.plugin) or list(PLUGIN_NAMES)
    unknown = next((name for name in selected_plugins if name not in PLUGIN_NAMES), None)
    if unknown: raise ValueError(f"Unknown plugin: {unknown}. Available plugins: {', '.join(PLUGIN_NAMES)}")
    local_tools = [tool for name in selected_plugins for tool in TOOL_DEFINITIONS if tool["function"]["name"] == name]
    aliases = split_mcp_aliases(args.mcp); configs = load_mcp_configs(aliases)
    loaded_mcp = []
    try:
        for config in configs:
            try: loaded = await load_mcp_tools(config)
            except (ValueError, RuntimeError, OSError, TimeoutError) as error: raise RuntimeError(f"MCP {config.alias} failed: {error}") from error
            loaded_mcp.append(loaded)
            print(f"MCP {config.alias}: connected ({loaded.protocol_version}, {len(loaded.tools)} tools)")
        skills = load_skills(args.skill); session = Session.open(args.session) if args.session else Session.create()
        try:
            tools = [*local_tools, *(tool for loaded in loaded_mcp for tool in loaded.tools)]
            agent = Agent(skills, session, load_project_instructions(), tools=tools)
            def show_tool(event):
                shown = {**event, "name": display_tool_name(event["name"])}
                print(f"\x1b[{'33' if event['phase'] == 'start' else '2'}m{format_tool_event(shown)}\x1b[0m")
            agent.on_tool = show_tool
            restored = "\nrestored: yes" if args.session else ""
            names = ", ".join(display_tool_name(tool["function"]["name"]) for tool in tools) or "(none)"
            print(f"\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nmodel: {Settings().tiny_model}\nsession: {session.id}\npath: {session.path}\ntools: {names}\nmcp: {', '.join(aliases) or '(none)'}{restored}")
            resume = lambda: print(f"\nResume: tiny-py --session {session.id}")
            try:
                with Terminal() as terminal:
                    if args.session:
                        recovered = await terminal.run(agent, agent.resume_session)
                        if recovered is not None:
                            print(f"\n\x1b[36m{recovered}\x1b[0m\n\x1b[2m{format_usage(agent.usage)}\x1b[0m")
                    if args.prompt:
                        print(f"\n{await terminal.run(agent, lambda: agent.run_agent_loop(' '.join(args.prompt)))}\n\x1b[2m{format_usage(agent.usage)}\x1b[0m"); resume(); return 0
                    print("Esc aborts the active operation; Ctrl+C exits.\n/compact  /skill:name  /exit")
                    while True:
                        text = terminal.readline("\x1b[32m›\x1b[0m ")
                        if not text: continue
                        if text == "/exit": break
                        if text == "/compact": answer = await terminal.run(agent, agent.compact)
                        elif text.startswith("/skill:"):
                            name, _, request = text[7:].partition(" "); skill = next((item for item in skills if item["name"] == name), None)
                            if not skill: print(f"Unknown skill: {name}"); continue
                            answer = await terminal.run(agent, lambda: agent.run_agent_loop(f"{Path(skill['path']).read_text(encoding='utf-8')}\n\nUser: {request}"))
                        else: answer = await terminal.run(agent, lambda: agent.run_agent_loop(text))
                        print(f"\x1b[36m{answer}\x1b[0m\n\x1b[2m{format_usage(agent.usage)}\x1b[0m")
            except KeyboardInterrupt:
                pass
            resume(); return 0
        finally:
            session.close()
    finally:
        for loaded in reversed(loaded_mcp):
            try: await loaded.close()
            except Exception: pass


def main() -> None:
    try: raise SystemExit(asyncio.run(run_cli()))
    except (ValueError, RuntimeError, OSError) as error: print(error, file=sys.stderr); raise SystemExit(1)
