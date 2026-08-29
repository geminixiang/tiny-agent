import argparse
import asyncio
import sys
import termios
import tty
from contextlib import suppress
from pathlib import Path

from .agent import Agent, TOOL_DEFINITIONS, close_background_processes, format_tool_event, format_usage, load_project_instructions, load_skills
from .mcp import display_tool_name, load_mcp_configs, load_mcp_tools, split_mcp_aliases, split_names
from .session import Session
from .settings import Settings
from .terminal import Terminal

PLUGIN_NAMES = tuple(tool["function"]["name"] for tool in TOOL_DEFINITIONS)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--session")
    parser.add_argument("--skill", action="append", default=[])
    parser.add_argument("--plugin", action="append", default=[])
    parser.add_argument("--mcp", action="append", default=[])
    parser.add_argument("prompt", nargs="*")
    return parser.parse_args(argv)


def selected_local_tools(raw_plugins: list[str]) -> list[dict]:
    selected = split_names(raw_plugins) or list(PLUGIN_NAMES)
    unknown = next((name for name in selected if name not in PLUGIN_NAMES), None)
    if unknown:
        raise ValueError(f"Unknown plugin: {unknown}. Available plugins: {', '.join(PLUGIN_NAMES)}")
    return [tool for name in selected for tool in TOOL_DEFINITIONS if tool["function"]["name"] == name]


async def connect_mcp(aliases: list[str]) -> list:
    loaded = []
    for config in load_mcp_configs(aliases):
        try:
            tools = await load_mcp_tools(config)
        except (ValueError, RuntimeError, OSError, TimeoutError) as error:
            raise RuntimeError(f"MCP {config.alias} failed: {error}") from error
        loaded.append(tools)
        print(f"MCP {config.alias}: connected ({tools.protocol_version}, {len(tools.tools)} tools)")
    return loaded


async def close_mcp(loaded_mcp: list) -> None:
    for loaded in reversed(loaded_mcp):
        with suppress(Exception):
            await loaded.close()


def install_tool_printer(agent: Agent) -> None:
    def show_tool(event):
        shown = {**event, "name": display_tool_name(event["name"])}
        color = "33" if event["phase"] == "start" else "2"
        print(f"\x1b[{color}m{format_tool_event(shown)}\x1b[0m")

    agent.on_tool = show_tool


def print_banner(session: Session, tools: list[dict], aliases: list[str], restored: bool) -> None:
    names = ", ".join(display_tool_name(tool["function"]["name"]) for tool in tools) or "(none)"
    restored_line = "\nrestored: yes" if restored else ""
    print(
        f"\x1b[36mtiny-agent\x1b[0m\n"
        f"provider: openrouter\n"
        f"endpoint: {Settings().tiny_endpoint}\n"
        f"model: {Settings().tiny_model}\n"
        f"session: {session.id}\n"
        f"path: {session.path}\n"
        f"tools: {names}\n"
        f"mcp: {', '.join(aliases) or '(none)'}{restored_line}"
    )


def print_answer(agent: Agent, answer: str) -> None:
    print(f"\x1b[36m{answer}\x1b[0m\n\x1b[2m{format_usage(agent.usage)}\x1b[0m")


async def run_one_shot(terminal: Terminal, agent: Agent, prompt: str) -> None:
    answer = await terminal.run(agent, lambda: agent.run_agent_loop(prompt))
    print(f"\n{answer}\n\x1b[2m{format_usage(agent.usage)}\x1b[0m")


async def run_skill(terminal: Terminal, agent: Agent, skills: list[dict], text: str) -> str | None:
    name, _, request = text[7:].partition(" ")
    skill = next((item for item in skills if item["name"] == name), None)
    if not skill:
        print(f"Unknown skill: {name}")
        return None
    content = Path(skill["path"]).read_text(encoding="utf-8")
    return await terminal.run(agent, lambda: agent.run_agent_loop(f"{content}\n\nUser: {request}"))


async def run_repl_command(terminal: Terminal, agent: Agent, skills: list[dict], text: str) -> str | None:
    if text == "/compact":
        return await terminal.run(agent, agent.compact)
    if text.startswith("/skill:"):
        return await run_skill(terminal, agent, skills, text)
    return await terminal.run(agent, lambda: agent.run_agent_loop(text))


async def run_repl(terminal: Terminal, agent: Agent, skills: list[dict]) -> None:
    print("Esc aborts the active operation; Ctrl+C exits.\n/compact  /skill:name  /exit")
    while True:
        text = terminal.readline("\x1b[32m›\x1b[0m ")
        if not text:
            continue
        if text == "/exit":
            return
        answer = await run_repl_command(terminal, agent, skills, text)
        if answer is None:
            continue
        print_answer(agent, answer)


async def run_terminal(args: argparse.Namespace, agent: Agent, skills: list[dict]) -> None:
    with Terminal() as terminal:
        if args.session:
            recovered = await terminal.run(agent, agent.resume_session)
            if recovered is not None:
                print_answer(agent, recovered)
        if args.prompt:
            await run_one_shot(terminal, agent, " ".join(args.prompt))
            return
        await run_repl(terminal, agent, skills)


async def run_session(args: argparse.Namespace, aliases: list[str], local_tools: list[dict], loaded_mcp: list) -> int:
    session = Session.open(args.session) if args.session else Session.create()
    try:
        skills = load_skills(args.skill)
        tools = [*local_tools, *(tool for loaded in loaded_mcp for tool in loaded.tools)]
        agent = Agent(skills, session, load_project_instructions(), tools=tools)
        install_tool_printer(agent)
        print_banner(session, tools, aliases, bool(args.session))
        with suppress(KeyboardInterrupt):
            await run_terminal(args, agent, skills)
        print(f"\nResume: tiny-py --session {session.id}")
        return 0
    finally:
        session.close()


async def run_cli(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    local_tools = selected_local_tools(args.plugin)
    aliases = split_mcp_aliases(args.mcp)
    loaded_mcp = await connect_mcp(aliases)
    try:
        return await run_session(args, aliases, local_tools, loaded_mcp)
    finally:
        await close_background_processes()
        await close_mcp(loaded_mcp)


def main() -> None:
    try:
        raise SystemExit(asyncio.run(run_cli()))
    except (ValueError, RuntimeError, OSError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
