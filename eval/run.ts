import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS = ["tiny-ts", "tiny-go", "tiny-py", "tiny-rs"];
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tasksDir = join(root, "eval/tasks");
const resultsPath = join(root, "eval/README.md");
const runsMarker = "<!-- EVAL_RUNS -->";

type CommandResult = {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
};

type Result = {
    task: string;
    taskVersion: string;
    agent: string;
    model: string;
    passed: boolean;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    toolCalls: number;
    detail: string;
};

type RunMetadata = {
    commit: string;
    dirty: boolean;
    platform: string;
    node: string;
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
    const lines = text.trim().split("\n");
    const header: unknown = JSON.parse(lines[0]);
    const model =
        header &&
        typeof header === "object" &&
        !Array.isArray(header) &&
        typeof (header as Record<string, unknown>).model === "string"
            ? String((header as Record<string, unknown>).model)
            : "unknown";
    const facts = lines.slice(1).flatMap((line) => {
        const value: unknown = JSON.parse(line);
        return Array.isArray(value) ? value : [value];
    });
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let toolCalls = 0;
    for (const value of facts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const fact = value as Record<string, unknown>;
        if (fact.kind === "usage" && fact.usage && typeof fact.usage === "object") {
            const usage = fact.usage as Record<string, unknown>;
            if (typeof usage.input === "number") inputTokens += usage.input;
            if (typeof usage.output === "number") outputTokens += usage.output;
            if (typeof usage.cacheRead === "number") cacheReadTokens += usage.cacheRead;
            if (typeof usage.cacheWrite === "number") cacheWriteTokens += usage.cacheWrite;
        }
        if (fact.kind !== "entry" || !fact.entry || typeof fact.entry !== "object") continue;
        const entry = fact.entry as Record<string, unknown>;
        if (entry.type !== "message" || !entry.message || typeof entry.message !== "object")
            continue;
        const message = entry.message as Record<string, unknown>;
        if (message.role === "assistant" && Array.isArray(message.tool_calls))
            toolCalls += message.tool_calls.length;
    }
    return { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, toolCalls };
}

async function sessionStats(workspace: string) {
    const dir = join(workspace, ".tiny-agent/sessions");
    let files: string[];
    try {
        files = await readdir(dir);
    } catch {
        return {
            model: "unknown",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolCalls: 0,
        };
    }
    const latest = files
        .filter((file) => file.endsWith(".jsonl"))
        .sort()
        .at(-1);
    if (!latest)
        return {
            model: "unknown",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolCalls: 0,
        };
    return sessionStatsFromJsonl(await readFile(join(dir, latest), "utf8"));
}

async function taskVersion(taskDir: string) {
    const files: string[] = [];
    async function collect(directory: string) {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await collect(path);
            else if (entry.isFile()) files.push(path);
        }
    }
    await collect(taskDir);
    const digest = createHash("sha256");
    for (const path of files.sort()) {
        digest.update(relative(taskDir, path));
        digest.update("\0");
        digest.update(await readFile(path));
        digest.update("\0");
    }
    return digest.digest("hex").slice(0, 12);
}

async function evaluate(task: string, agent: string): Promise<Result> {
    const taskDir = join(tasksDir, task);
    const workspace = await mkdtemp(join(tmpdir(), `tiny-eval-${task}-${agent}-`));
    const prompt = (await readFile(join(taskDir, "prompt.txt"), "utf8")).trim();
    const version = await taskVersion(taskDir);
    try {
        await cp(join(taskDir, "fixture"), workspace, { recursive: true });
        const initialized = await run(
            "git",
            ["-c", "user.name=tiny-eval", "-c", "user.email=eval@tiny-agent.local", "init", "-q"],
            workspace,
            10_000,
        );
        if (initialized.code !== 0)
            throw new Error(`Could not initialize eval workspace: ${initialized.stderr}`);
        const staged = await run("git", ["add", "."], workspace, 10_000);
        if (staged.code !== 0) throw new Error(`Could not stage eval fixture: ${staged.stderr}`);
        const committed = await run(
            "git",
            [
                "-c",
                "user.name=tiny-eval",
                "-c",
                "user.email=eval@tiny-agent.local",
                "commit",
                "-qm",
                "eval fixture",
            ],
            workspace,
            10_000,
        );
        if (committed.code !== 0)
            throw new Error(`Could not commit eval fixture: ${committed.stderr}`);
        const started = performance.now();
        const agentResult = await run(agent, [prompt], workspace, 120_000);
        const durationMs = performance.now() - started;
        const verifier = await run("bash", [join(taskDir, "test.sh")], workspace, 30_000);
        const stats = await sessionStats(workspace);
        const passed = !agentResult.timedOut && agentResult.code === 0 && verifier.code === 0;
        let detail = "";
        if (agentResult.timedOut) detail = "agent timeout";
        else if (agentResult.code !== 0)
            detail = `agent exit ${agentResult.code}: ${agentResult.stderr.trim()}`;
        else if (verifier.code !== 0)
            detail = verifier.stderr.trim() || verifier.stdout.trim() || "verifier failed";
        return {
            task,
            taskVersion: version,
            agent,
            passed,
            durationMs,
            ...stats,
            detail,
        };
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}

function median(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function resultMarkdown(results: Result[], metadata: RunMetadata) {
    const timestamp = new Date().toISOString();
    const lines = [
        `## ${timestamp}`,
        "",
        `Commit: \`${metadata.commit}${metadata.dirty ? "+dirty" : ""}\` · Platform: \`${metadata.platform}\` · Node: \`${metadata.node}\``,
        "",
        "### Summary",
        "",
        "| Agent | Model | Passed | Pass rate | Median time | Median tokens | Median tools |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ];
    const agents = [...new Set(results.map((result) => result.agent))];
    for (const agent of agents) {
        const attempts = results.filter((result) => result.agent === agent);
        const passed = attempts.filter((result) => result.passed).length;
        const models = [...new Set(attempts.map((result) => result.model))].join(", ");
        lines.push(
            `| ${agent} | ${models} | ${passed}/${attempts.length} | ${((passed / attempts.length) * 100).toFixed(1)}% | ${(median(attempts.map((result) => result.durationMs)) / 1000).toFixed(1)}s | ${Math.round(median(attempts.map((result) => result.inputTokens + result.outputTokens)))} | ${median(attempts.map((result) => result.toolCalls))} |`,
        );
    }
    lines.push(
        "",
        "### Tasks",
        "",
        "| Task | Spec | Agent | Model | Result | Time | Input | Output | Cache read | Cache write | Tools | Detail |",
        "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const result of results) {
        const detail = result.detail.replaceAll("\n", " ").replaceAll("|", "\\|");
        lines.push(
            `| ${result.task} | \`${result.taskVersion}\` | ${result.agent} | ${result.model} | ${result.passed ? "PASS" : "FAIL"} | ${(result.durationMs / 1000).toFixed(1)}s | ${result.inputTokens} | ${result.outputTokens} | ${result.cacheReadTokens} | ${result.cacheWriteTokens} | ${result.toolCalls} | ${detail} |`,
        );
    }
    lines.push("");
    return `${lines.join("\n")}\n`;
}

export function insertResultMarkdown(previous: string, run: string) {
    if (!previous.includes(runsMarker)) return `${run}${previous}`;
    return previous.replace(runsMarker, `${runsMarker}\n\n${run.trimEnd()}`);
}

async function writeResultsMarkdown(results: Result[], metadata: RunMetadata) {
    let previous = "";
    try {
        previous = await readFile(resultsPath, "utf8");
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const content = insertResultMarkdown(previous, resultMarkdown(results, metadata));
    await mkdir(join(root, "eval"), { recursive: true });
    await writeFile(resultsPath, content, "utf8");
}

async function runMetadata(): Promise<RunMetadata> {
    const revision = await run("git", ["rev-parse", "--short=12", "HEAD"], root, 10_000);
    const status = await run("git", ["status", "--porcelain"], root, 10_000);
    if (revision.code !== 0)
        throw new Error(`Could not read benchmark revision: ${revision.stderr}`);
    if (status.code !== 0) throw new Error(`Could not read benchmark status: ${status.stderr}`);
    return {
        commit: revision.stdout.trim(),
        dirty: Boolean(status.stdout.trim()),
        platform: `${platform()}-${arch()}`,
        node: process.version,
    };
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
    if (!process.env.OPENROUTER_API_KEY)
        throw new Error("Set OPENROUTER_API_KEY before running evals.");

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
            `${result.task.padEnd(taskWidth)} ${result.agent.padEnd(8)} ${(result.passed ? "PASS" : "FAIL").padEnd(7)} ${(result.durationMs / 1000).toFixed(1).padStart(5)}s ${String(result.inputTokens + result.outputTokens).padStart(7)} ${String(result.toolCalls).padStart(5)}`,
        );
        if (result.detail) console.log(`  ${result.detail.split("\n").at(-1)}`);
    }
    await writeResultsMarkdown(results, await runMetadata());
    console.log(`\nWrote eval/README.md`);
    if (results.some((result) => !result.passed)) process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
