#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { parseArgs } from "node:util";
import {
    Agent,
    ENDPOINT,
    MODEL,
    Session,
    displayToolName,
    loadProjectInstructions,
    loadSkills,
    formatToolEvent,
    formatUsage,
    type RunEvent,
    type RunResult,
    type SessionStore,
    builtInPlugins,
    closeBackgroundProcesses,
} from "./index.js";
import { loadMcpConfigs } from "./mcp-config.js";
import { loadMcpTools, type LoadedMcpTools } from "./mcp.js";

const activeMcp: LoadedMcpTools[] = [];
let activeSession: SessionStore | undefined;

function parseCLIArgs(args = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({
        args,
        options: {
            session: { type: "string" },
            cwd: { type: "string" },
            skill: { type: "string", multiple: true },
            json: { type: "boolean" },
            plugin: { type: "string", multiple: true },
            mcp: { type: "string", multiple: true },
        },
        allowPositionals: true,
    });
    return {
        sessionId: values.session,
        cwd: values.cwd,
        extras: values.skill ?? [],
        json: values.json ?? false,
        plugins: splitList(values.plugin),
        mcp: splitList(values.mcp),
        oneShot: positionals.join(" "),
    };
}

function splitList(values?: string[]) {
    return [
        ...new Set(
            (values ?? [])
                .flatMap((value) => value.split(","))
                .map((value) => value.trim())
                .filter(Boolean),
        ),
    ];
}

async function changeCwd(cwd: string | undefined) {
    if (!cwd) return;
    const path = resolve(cwd);
    const info = await stat(path);
    if (!info.isDirectory()) throw Error(`--cwd must be a directory: ${cwd}`);
    process.chdir(path);
}

async function main() {
    const { sessionId, cwd, extras, json, plugins, mcp, oneShot } = parseCLIArgs();
    await changeCwd(cwd);
    if (json && !oneShot) throw Error("--json requires a one-shot prompt.");
    const emit = (event: RunEvent | Record<string, unknown>) => {
        if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
    };
    const selectedPlugins = plugins.length ? plugins : builtInPlugins.map((plugin) => plugin.name);
    const unknown = selectedPlugins.find((name) => !builtInPlugins.some((plugin) => plugin.name === name));
    if (unknown) {
        throw Error(
            `Unknown plugin: ${unknown}. Available plugins: ${builtInPlugins.map((plugin) => plugin.name).join(", ")}`,
        );
    }
    const localTools = selectedPlugins.flatMap(
        (name) => builtInPlugins.find((plugin) => plugin.name === name)?.tools ?? [],
    );
    const loadedMcp = activeMcp;
    const configs = await loadMcpConfigs(mcp);
    const skills = await loadSkills(extras);
    const instructions = await loadProjectInstructions();
    const session = sessionId
        ? await Session.open(sessionId, process.cwd())
        : await Session.create(process.cwd(), MODEL);
    activeSession = session;
    const runStarted = performance.now();
    if (json) {
        emit({
            type: "run.started",
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            model: MODEL,
            endpoint: ENDPOINT,
            plugins: selectedPlugins,
            mcp,
        });
    }
    for (const config of configs) {
        const started = performance.now();
        try {
            const loaded = await loadMcpTools(config, AbortSignal.timeout(10_000));
            loadedMcp.push(loaded);
            emit({
                type: "mcp.connected",
                timestamp: new Date().toISOString(),
                server: config.alias,
                protocolVersion: loaded.protocolVersion,
                toolCount: loaded.tools.length,
                durationMs: performance.now() - started,
            });
            if (!json) {
                console.log(`MCP ${config.alias}: connected (${loaded.protocolVersion}, ${loaded.tools.length} tools)`);
            }
        } catch (error) {
            const cause = mcpFailureCause(error);
            emit({
                type: "mcp.failed",
                timestamp: new Date().toISOString(),
                server: config.alias,
                stage: "connect",
                cause,
            });
            if (json) {
                emit({
                    type: "run.completed",
                    timestamp: new Date().toISOString(),
                    durationMs: performance.now() - runStarted,
                    result: {
                        status: "failed",
                        cause: "mcp_setup_error",
                        message: `MCP ${config.alias} failed: ${cause}`,
                        sessionId: session.id,
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    } satisfies RunResult,
                });
                process.exitCode = 1;
                return;
            }
            throw Error(`MCP ${config.alias} failed: ${cause}`);
        }
    }
    const tools = [...localTools, ...loadedMcp.flatMap((loaded) => loaded.tools)];
    const showTool = (event: Parameters<typeof formatToolEvent>[0]) => {
        if (!json) {
            console.log(
                `\x1b[${event.phase === "start" ? "33" : "2"}m${formatToolEvent({ ...event, name: displayToolName(event.name) })}\x1b[0m`,
            );
        }
    };
    const agent = new Agent(skills, fetch, session, showTool, instructions, emit, tools);
    if (sessionId) await agent.resumeSession();
    const resume = () => {
        if (!json) console.log(`\nResume: tiny-ts --session ${session.id}`);
    };
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) => new Promise<string>((ok) => rl.question(q, ok));
    emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    let exiting = false;
    const requestAbort = () => {
        void agent.abort().catch((error: unknown) => {
            console.error(`Failed to persist abort: ${error instanceof Error ? error.message : String(error)}`);
        });
    };
    const onInterrupt = () => {
        exiting = true;
        if (agent.busy) requestAbort();
        else rl.write("/exit\n");
    };
    const onKeypress = (_: string, key: { name?: string }) => {
        if (key.name !== "escape" || !agent.busy) return;
        console.log("\n\x1b[33mAborting...\x1b[0m");
        requestAbort();
    };
    rl.on("SIGINT", onInterrupt);
    process.stdin.on("keypress", onKeypress);
    const close = async () => {
        rl.off("SIGINT", onInterrupt);
        process.stdin.off("keypress", onKeypress);
        rl.close();
        await session.close();
        resume();
    };
    if (!json) {
        console.log(
            `\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nendpoint: ${ENDPOINT}\nmodel: ${MODEL}\nsession: ${session.id}\npath: ${session.path}\ntools: ${tools.map((tool) => displayToolName(tool.name)).join(", ") || "(none)"}\nmcp: ${mcp.join(", ") || "(none)"}${sessionId ? "\nrestored: yes" : ""}`,
        );
    }
    if (oneShot) {
        if (json) {
            try {
                const answer = await agent.runAgentLoop(oneShot);
                emit({
                    type: "run.completed",
                    timestamp: new Date().toISOString(),
                    durationMs: performance.now() - runStarted,
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
                    durationMs: performance.now() - runStarted,
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
            await close();
            return;
        }
        console.log(`\n${await agent.runAgentLoop(oneShot)}`);
        console.log(`\x1b[2m${formatUsage(agent.usage)}\x1b[0m`);
        await close();
        return;
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
    await close();
}

async function closeMcp(loaded: LoadedMcpTools[]) {
    for (const client of loaded.toReversed()) {
        try {
            await client.close();
        } catch {
            // Cleanup remains best-effort and never replaces the run result, but stale remote sessions must be visible.
            console.error("MCP cleanup failed; the remote session may remain until server timeout.");
        }
    }
}

function mcpFailureCause(error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
    if (error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)) return "timeout";
    return "connection_failed";
}

main()
    .finally(async () => {
        await closeBackgroundProcesses();
        await closeMcp(activeMcp);
        await activeSession?.close();
    })
    .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
