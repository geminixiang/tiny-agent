import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS = ["tiny-ts", "tiny-go", "tiny-py", "tiny-rs"];
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tasksDir = join(root, "eval/tasks");

type CommandResult = {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
};

type Result = {
    task: string;
    agent: string;
    passed: boolean;
    durationMs: number;
    tokens: number;
    toolCalls: number;
    detail: string;
};

function run(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    env = process.env,
): Promise<CommandResult> {
    return new Promise((done, fail) => {
        const child = spawn(command, args, {
            cwd,
            env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", fail);
        const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
            else child.kill("SIGTERM");
        }, timeoutMs);
        child.on("close", (code) => {
            clearTimeout(timer);
            done({ code, stdout, stderr, timedOut });
        });
    });
}

export function sessionStatsFromJsonl(text: string) {
    const facts = text
        .trim()
        .split("\n")
        .slice(1)
        .flatMap((line) => {
            const value: unknown = JSON.parse(line);
            return Array.isArray(value) ? value : [value];
        });
    let tokens = 0;
    let toolCalls = 0;
    for (const value of facts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const fact = value as Record<string, unknown>;
        if (fact.kind === "usage" && fact.usage && typeof fact.usage === "object") {
            const usage = fact.usage as Record<string, unknown>;
            for (const name of ["input", "output"]) {
                if (typeof usage[name] === "number") tokens += usage[name];
            }
        }
        if (fact.kind !== "entry" || !fact.entry || typeof fact.entry !== "object") continue;
        const entry = fact.entry as Record<string, unknown>;
        if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
        const message = entry.message as Record<string, unknown>;
        if (message.role === "assistant" && Array.isArray(message.tool_calls)) toolCalls += message.tool_calls.length;
    }
    return { tokens, toolCalls };
}

async function sessionStats(workspace: string) {
    const dir = join(workspace, ".tiny-agent/sessions");
    let files: string[];
    try {
        files = await readdir(dir);
    } catch {
        return { tokens: 0, toolCalls: 0 };
    }
    const latest = files
        .filter((file) => file.endsWith(".jsonl"))
        .sort()
        .at(-1);
    if (!latest) return { tokens: 0, toolCalls: 0 };
    return sessionStatsFromJsonl(await readFile(join(dir, latest), "utf8"));
}

async function evaluate(task: string, agent: string): Promise<Result> {
    const taskDir = join(tasksDir, task);
    const workspace = await mkdtemp(join(tmpdir(), `tiny-eval-${task}-${agent}-`));
    const prompt = (await readFile(join(taskDir, "prompt.txt"), "utf8")).trim();
    const started = performance.now();
    try {
        await cp(join(taskDir, "fixture"), workspace, { recursive: true });
        const initialized = await run(
            "git",
            ["-c", "user.name=tiny-eval", "-c", "user.email=eval@tiny-agent.local", "init", "-q"],
            workspace,
            10_000,
        );
        if (initialized.code !== 0) throw new Error(`Could not initialize eval workspace: ${initialized.stderr}`);
        const staged = await run("git", ["add", "."], workspace, 10_000);
        if (staged.code !== 0) throw new Error(`Could not stage eval fixture: ${staged.stderr}`);
        const committed = await run(
            "git",
            ["-c", "user.name=tiny-eval", "-c", "user.email=eval@tiny-agent.local", "commit", "-qm", "eval fixture"],
            workspace,
            10_000,
        );
        if (committed.code !== 0) throw new Error(`Could not commit eval fixture: ${committed.stderr}`);
        const agentResult = await run(agent, [prompt], workspace, 120_000);
        const verifier = await run("bash", [join(taskDir, "test.sh")], workspace, 30_000);
        const stats = await sessionStats(workspace);
        const passed = !agentResult.timedOut && agentResult.code === 0 && verifier.code === 0;
        let detail = "";
        if (agentResult.timedOut) detail = "agent timeout";
        else if (agentResult.code !== 0) detail = `agent exit ${agentResult.code}: ${agentResult.stderr.trim()}`;
        else if (verifier.code !== 0) detail = verifier.stderr.trim() || verifier.stdout.trim() || "verifier failed";
        return {
            task,
            agent,
            passed,
            durationMs: performance.now() - started,
            ...stats,
            detail,
        };
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}

async function main() {
    const selectedAgent = process.env.AGENT;
    const selectedTask = process.env.TASK;
    const agents = selectedAgent ? [selectedAgent] : AGENTS;
    const availableTasks = (await readdir(tasksDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    const tasks = selectedTask ? [selectedTask] : availableTasks;
    for (const agent of agents) {
        if (!AGENTS.includes(agent)) throw new Error(`Unknown AGENT: ${agent}`);
    }
    for (const task of tasks) {
        if (!availableTasks.includes(task)) throw new Error(`Unknown TASK: ${task}`);
    }
    if (!process.env.OPENROUTER_API_KEY) throw new Error("Set OPENROUTER_API_KEY before running evals.");

    const results: Result[] = [];
    for (const task of tasks) {
        for (const agent of agents) {
            process.stdout.write(`Running ${task} with ${agent}... `);
            const result = await evaluate(task, agent);
            results.push(result);
            console.log(result.passed ? "PASS" : "FAIL");
        }
    }

    const taskWidth = Math.max(8, ...results.map((result) => result.task.length));
    console.log(`\n${"Task".padEnd(taskWidth)} Agent    Result  Time   Tokens  Tools`);
    console.log(`${"-".repeat(taskWidth)} -------- ------- ------ ------- -----`);
    for (const result of results) {
        console.log(
            `${result.task.padEnd(taskWidth)} ${result.agent.padEnd(8)} ${(result.passed ? "PASS" : "FAIL").padEnd(7)} ${(result.durationMs / 1000).toFixed(1).padStart(5)}s ${String(result.tokens).padStart(7)} ${String(result.toolCalls).padStart(5)}`,
        );
        if (result.detail) console.log(`  ${result.detail.split("\n").at(-1)}`);
    }
    if (results.some((result) => !result.passed)) process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
