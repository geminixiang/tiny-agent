#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface, emitKeypressEvents } from "node:readline";
import { parseArgs } from "node:util";
import {
    Agent,
    MODEL,
    Session,
    loadProjectInstructions,
    loadSkills,
    formatToolEvent,
    formatUsage,
    type RunEvent,
    type RunResult,
    builtInPlugins,
} from "./index.js";

function parseCLIArgs(args = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({
        args,
        options: {
            session: { type: "string" },
            skill: { type: "string", multiple: true },
            json: { type: "boolean" },
            plugin: { type: "string", multiple: true },
        },
        allowPositionals: true,
    });
    return {
        sessionId: values.session,
        extras: values.skill ?? [],
        json: values.json ?? false,
        plugins: [
            ...new Set(
                (values.plugin ?? [])
                    .flatMap((value) => value.split(","))
                    .map((value) => value.trim())
                    .filter(Boolean),
            ),
        ],
        oneShot: positionals.join(" "),
    };
}

async function main() {
    const { sessionId, extras, json, plugins, oneShot } = parseCLIArgs();
    if (json && !oneShot) throw Error("--json requires a one-shot prompt.");
    const selectedPlugins = plugins.length ? plugins : builtInPlugins.map((plugin) => plugin.name);
    const unknown = selectedPlugins.find((name) => !builtInPlugins.some((plugin) => plugin.name === name));
    if (unknown) {
        throw Error(
            `Unknown plugin: ${unknown}. Available plugins: ${builtInPlugins.map((plugin) => plugin.name).join(", ")}`,
        );
    }
    const tools = selectedPlugins.flatMap((name) => builtInPlugins.find((plugin) => plugin.name === name)?.tools ?? []);
    const skills = await loadSkills(extras),
        instructions = await loadProjectInstructions();
    const session = sessionId ? await Session.open(sessionId) : await Session.create();
    const showTool = (event: Parameters<typeof formatToolEvent>[0]) => {
        if (!json) console.log(`\x1b[${event.phase === "start" ? "33" : "2"}m${formatToolEvent(event)}\x1b[0m`);
    };
    const emit = (event: RunEvent | Record<string, unknown>) => {
        if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
    };
    const agent = new Agent(skills, fetch, session, showTool, instructions, emit, tools);
    if (sessionId) await agent.resumeSession();
    const resume = () => {
        if (!json) console.log(`\nResume: tiny-ts --session ${session.id}`);
    };
    const rl = createInterface({ input: process.stdin, output: process.stdout }),
        ask = (q: string) => new Promise<string>((ok) => rl.question(q, ok));
    emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    let exiting = false;
    const onInterrupt = () => {
        exiting = true;
        if (agent.busy) agent.abort();
        else rl.write("/exit\n");
    };
    const onKeypress = (_: string, key: { name?: string }) => {
        if (key.name !== "escape" || !agent.busy) return;
        console.log("\n\x1b[33mAborting...\x1b[0m");
        agent.abort();
    };
    rl.on("SIGINT", onInterrupt);
    process.stdin.on("keypress", onKeypress);
    const close = () => {
        rl.off("SIGINT", onInterrupt);
        process.stdin.off("keypress", onKeypress);
        rl.close();
        resume();
    };
    if (!json) {
        console.log(
            `\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nmodel: ${MODEL}\nsession: ${session.id}\npath: ${session.path}${sessionId ? "\nrestored: yes" : ""}`,
        );
    }
    if (oneShot) {
        if (json) {
            const started = performance.now();
            emit({
                type: "run.started",
                timestamp: new Date().toISOString(),
                sessionId: session.id,
                model: MODEL,
                plugins: selectedPlugins,
            });
            try {
                const answer = await agent.runAgentLoop(oneShot);
                emit({
                    type: "run.completed",
                    timestamp: new Date().toISOString(),
                    durationMs: performance.now() - started,
                    result: {
                        status: answer === "Operation aborted." ? "cancelled" : "succeeded",
                        answer,
                        sessionId: session.id,
                        usage: agent.usage,
                    } satisfies RunResult,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                emit({
                    type: "run.completed",
                    timestamp: new Date().toISOString(),
                    durationMs: performance.now() - started,
                    result: {
                        status: "failed",
                        cause: "agent_error",
                        message,
                        sessionId: session.id,
                        usage: agent.usage,
                    } satisfies RunResult,
                });
                process.exitCode = 1;
            }
            return close();
        }
        console.log(`\n${await agent.runAgentLoop(oneShot)}`);
        console.log(`\x1b[2m${formatUsage(agent.usage)}\x1b[0m`);
        return close();
    }
    console.log("Esc aborts the active operation; Ctrl+C exits.\n/compact  /skill:name  /exit");
    while (true) {
        const input = (await ask("\x1b[32m›\x1b[0m ")).trim();
        if (!input) continue;
        if (input === "/exit") break;
        if (input === "/compact") {
            console.log(await agent.compact());
            if (exiting) break;
            console.log(`\x1b[2m${formatUsage(agent.usage)}\x1b[0m`);
            continue;
        }
        if (input.startsWith("/skill:")) {
            const [name, ...rest] = input.slice(7).split(" "),
                skill = skills.find((s) => s.name === name);
            if (!skill) {
                console.log(`Unknown skill: ${name}`);
                continue;
            }
            const answer = await agent.runAgentLoop(`${await readFile(skill.path, "utf8")}\n\nUser: ${rest.join(" ")}`);
            if (exiting) break;
            console.log(answer);
            console.log(`\x1b[2m${formatUsage(agent.usage)}\x1b[0m`);
            continue;
        }
        const answer = await agent.runAgentLoop(input);
        if (exiting) break;
        console.log(`\x1b[36m${answer}\x1b[0m`);
        console.log(`\x1b[2m${formatUsage(agent.usage)}\x1b[0m`);
    }
    close();
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
