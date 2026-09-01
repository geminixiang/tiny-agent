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
    ExecutionLifecycleProjector,
    callbackSink,
    noLifecycle,
    type ExecutionLifecycle,
    type LifecycleEvent,
    type LifecycleSink,
    type SessionStore,
    builtInPlugins,
    closeBackgroundProcesses,
} from "./index.js";
import { loadMcpConfigs } from "./mcp-config.js";
import { loadMcpTools, type LoadedMcpTools } from "./mcp.js";
import { createTelemetry, noTelemetry } from "./telemetry.js";

const activeMcp: LoadedMcpTools[] = [];
let activeSession: SessionStore | undefined;
let activeTelemetry: LifecycleSink = noTelemetry;
let activeLifecycle: ExecutionLifecycle = noLifecycle;
let structuredOutput = false;

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
    structuredOutput = json;
    const selectedPlugins = plugins.length ? plugins : builtInPlugins.map((plugin) => plugin.name);
    const unknown = selectedPlugins.find((name) => !builtInPlugins.some((plugin) => plugin.name === name));
    if (unknown) {
        throw Error(
            `Unknown plugin: ${unknown}. Available plugins: ${builtInPlugins.map((plugin) => plugin.name).join(", ")}`,
        );
    }
    activeTelemetry = await createTelemetry();
    const localTools = selectedPlugins.flatMap(
        (name) => builtInPlugins.find((plugin) => plugin.name === name)?.tools ?? [],
    );
    activeLifecycle = new ExecutionLifecycleProjector([
        activeTelemetry,
        ...(json ? [callbackSink((event: LifecycleEvent) => process.stdout.write(`${JSON.stringify(event)}\n`))] : []),
    ]);
    const startupStarted = performance.now();
    let startupCompleted = false;
    const completeStartup = (outcome: "succeeded" | "failed", errorType?: string) => {
        if (startupCompleted) return;
        startupCompleted = true;
        activeLifecycle.observe({
            type: "startup.completed",
            timestamp: new Date().toISOString(),
            durationMs: performance.now() - startupStarted,
            outcome,
            ...(errorType ? { errorType } : {}),
        });
    };
    activeLifecycle.observe({
        type: "startup.started",
        timestamp: new Date().toISOString(),
        model: MODEL,
        runtime: "typescript",
        plugins: selectedPlugins,
        mcp,
    });
    const loadedMcp = activeMcp;
    let configs: Awaited<ReturnType<typeof loadMcpConfigs>>;
    let skills: Awaited<ReturnType<typeof loadSkills>>;
    let instructions: string;
    let session: SessionStore;
    try {
        configs = await loadMcpConfigs(mcp);
        skills = await loadSkills(extras);
        instructions = await loadProjectInstructions();
        session = sessionId ? await Session.open(sessionId, process.cwd()) : await Session.create(process.cwd(), MODEL);
    } catch (error) {
        completeStartup("failed", "startup_setup_error");
        throw error;
    }
    activeSession = session;
    activeLifecycle.observe({
        type: "session.attached",
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        resumed: Boolean(sessionId),
    });
    for (const config of configs) {
        const started = performance.now();
        activeLifecycle.observe({ type: "mcp.started", timestamp: new Date().toISOString(), server: config.alias });
        try {
            const loaded = await loadMcpTools(config, AbortSignal.timeout(10_000));
            loadedMcp.push(loaded);
            activeLifecycle.observe({
                type: "mcp.completed",
                timestamp: new Date().toISOString(),
                server: config.alias,
                outcome: "succeeded",
                protocolVersion: loaded.protocolVersion,
                toolCount: loaded.tools.length,
                durationMs: performance.now() - started,
            });
            if (!json) {
                console.log(`MCP ${config.alias}: connected (${loaded.protocolVersion}, ${loaded.tools.length} tools)`);
            }
        } catch (error) {
            const cause = mcpFailureCause(error);
            activeLifecycle.observe({
                type: "mcp.completed",
                timestamp: new Date().toISOString(),
                server: config.alias,
                outcome: "failed",
                errorType: cause,
                durationMs: performance.now() - started,
            });
            completeStartup("failed", "mcp_setup_error");
            if (!json) throw Error(`MCP ${config.alias} failed: ${cause}`);
            process.exitCode = 1;
            return;
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
    let agent: Agent;
    try {
        agent = new Agent(skills, fetch, session, showTool, instructions, activeLifecycle, tools);
    } catch (error) {
        completeStartup("failed", "agent_setup_error");
        throw error;
    }
    completeStartup("succeeded");
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
        await bestEffort(() => session.close());
        resume();
    };
    if (!json) {
        console.log(
            `\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nendpoint: ${ENDPOINT}\nmodel: ${MODEL}\nsession: ${session.id}\npath: ${session.path}\ntools: ${tools.map((tool) => displayToolName(tool.name)).join(", ") || "(none)"}\nmcp: ${mcp.join(", ") || "(none)"}${sessionId ? "\nrestored: yes" : ""}`,
        );
    }
    if (oneShot) {
        try {
            const answer = await agent.runAgentLoop(oneShot);
            if (!json) {
                console.log(`\n${answer}`);
                console.log(`\x1b[2m${formatUsage(agent.usage)}\x1b[0m`);
            }
        } catch (error) {
            if (!json) throw error;
            process.exitCode = 1;
        }
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

async function bestEffort(cleanup: () => Promise<unknown>) {
    try {
        await cleanup();
    } catch {
        // Cleanup failures never replace the primary result and later cleanup still runs.
    }
}

function mcpFailureCause(error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
    if (error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)) return "timeout";
    return "connection_failed";
}

main()
    .finally(async () => {
        await bestEffort(closeBackgroundProcesses);
        await bestEffort(() => closeMcp(activeMcp));
        await bestEffort(async () => activeSession?.close());
        await bestEffort(() => activeLifecycle.close());
    })
    .catch((error) => {
        if (!structuredOutput) console.error(error.message);
        process.exitCode = 1;
    });
