import { exec, type ExecException } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(exec),
    root = process.cwd(),
    MAX_TOOL_OUTPUT = 50 * 1024;

type ToolEdit = { oldText: string; newText: string };
export type ToolArgs = {
    [key: string]: unknown;
    command?: string;
    timeout?: number;
    path?: string;
    content?: string;
    offset?: number;
    limit?: number;
    edits?: ToolEdit[];
};
export type Plugin = {
    name: string;
    tools: Tool[];
};
export type Tool = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(args: ToolArgs, signal?: AbortSignal): Promise<string>;
};
export type ToolEvent = {
    phase: "start" | "end";
    name: string;
    args: ToolArgs;
    result?: string;
};

export function formatToolEvent({ phase, name, args, result }: ToolEvent) {
    if (phase === "end") {
        if (result?.startsWith("Error:") || result === "Operation aborted") return `  └ ${result}`;
        return `  └ ${result === "ok" || result === "(no output)" ? result : `${result?.length ?? 0} chars`}`;
    }
    const target = name === "bash" ? args.command : args.path,
        suffix =
            name === "write"
                ? ` (${args.content?.length ?? 0} chars)`
                : name === "edit"
                  ? ` (${args.edits?.length ?? 0} blocks)`
                  : "";
    return `◆ ${name}${target ? ` ${target.length > 80 ? target.slice(0, 77) + "..." : target}` : ""}${suffix}`;
}

const toolMetadata = [
    {
        name: "bash",
        description:
            "Run commands, builds, tests, and file discovery in the working directory. Use read, write, or edit for ordinary text file operations. Output is limited to the last 2,000 lines or 50KB; truncated output includes a full-output path.",
        properties: {
            command: { type: "string", description: "Shell command to execute in the working directory." },
            timeout: {
                type: "number",
                exclusiveMinimum: 0,
                description: "Optional timeout in seconds. Defaults to 120.",
            },
        },
        required: ["command"],
    },
    {
        name: "read",
        description:
            "Read a UTF-8 text file. Prefer this over cat or sed. Returns at most 2,000 complete lines or 50KB and includes an offset hint when more lines remain.",
        properties: {
            path: { type: "string", description: "Path to the UTF-8 text file within the working directory." },
            offset: { type: "integer", minimum: 1, description: "1-indexed line number to start reading from." },
            limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return." },
        },
        required: ["path"],
    },
    {
        name: "write",
        description:
            "Create a new UTF-8 text file or completely rewrite an existing file. Parent directories are created automatically. Use edit for partial changes.",
        properties: {
            path: { type: "string", description: "Path to create or completely rewrite." },
            content: { type: "string", description: "Complete UTF-8 file content." },
        },
        required: ["path", "content"],
    },
    {
        name: "edit",
        description:
            "Make precise replacements in an existing UTF-8 text file. Every oldText must match exactly once in the original file, and edits must not overlap. All edits are validated before writing.",
        properties: {
            path: { type: "string", description: "Path to the existing UTF-8 text file." },
            edits: {
                type: "array",
                minItems: 1,
                description: "Non-overlapping replacements, all matched against the original file.",
                items: {
                    type: "object",
                    properties: {
                        oldText: {
                            type: "string",
                            minLength: 1,
                            description: "Exact text that must occur exactly once in the original file.",
                        },
                        newText: { type: "string", description: "Replacement text." },
                    },
                    required: ["oldText", "newText"],
                },
            },
        },
        required: ["path", "edits"],
    },
];

export const builtInTools: Tool[] = toolMetadata.map(({ name, description, properties, required }) => ({
    name,
    description,
    parameters: { type: "object", properties, required },
    execute: (args, signal) => executeBuiltInTool(name, args, signal),
}));

export const builtInPlugins: Plugin[] = builtInTools.map((tool) => ({ name: tool.name, tools: [tool] }));

export function toolDefinitions(tools: Tool[]) {
    return tools.map(({ name, description, parameters }) => ({
        type: "function",
        function: { name, description, parameters },
    }));
}

function pathInRoot(path: string) {
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + "/")) throw Error("path must stay inside cwd");
    return full;
}

async function limitBashOutput(output: string, complete = true) {
    const lines = output.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length <= 2_000 && Buffer.byteLength(output) <= MAX_TOOL_OUTPUT) return output;
    const buffer = Buffer.from(output);
    let byteStart = Math.max(0, buffer.length - MAX_TOOL_OUTPUT);
    while (byteStart < buffer.length && (buffer[byteStart] & 0xc0) === 0x80) byteStart++;
    let tailLines = buffer.subarray(byteStart).toString().split("\n");
    if (tailLines.length > 2_000) tailLines = tailLines.slice(-2_000);
    const tail = tailLines.join("\n"),
        start = Math.max(1, lines.length - tailLines.length + 1),
        path = resolve(root, ".tiny-agent/tool-output", `${randomUUID()}.log`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output);
    const label = complete ? "Full output" : "Captured output; command exceeded the 10MB safety cap";
    return `${tail}\n\n[Showing lines ${start}-${lines.length} of ${lines.length}. ${label}: ${path}]`;
}

function readLines(text: string, offset = 1, limit = 2_000) {
    if (!Number.isInteger(offset) || offset < 1) throw Error("offset must be an integer >= 1");
    if (!Number.isInteger(limit) || limit < 1) throw Error("limit must be an integer >= 1");
    const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (!lines.length) {
        if (offset === 1) return "";
        throw Error(`Offset ${offset} is beyond end of file (0 lines total).`);
    }
    if (offset > lines.length) throw Error(`Offset ${offset} is beyond end of file (${lines.length} lines total).`);
    const selected: string[] = [];
    for (const line of lines.slice(offset - 1, offset - 1 + Math.min(limit, 2_000))) {
        const next = selected.length ? `${selected.join("\n")}\n${line}` : line;
        if (Buffer.byteLength(next) > MAX_TOOL_OUTPUT) break;
        selected.push(line);
    }
    if (!selected.length)
        return `Line ${offset} exceeds 50KB. Use bash with a byte-oriented command to inspect this line.`;
    const end = offset + selected.length - 1;
    return `${selected.join("\n")}${end < lines.length ? `\n\n[Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]` : ""}`;
}

export function toolResultOK(content: string) {
    return ![
        "Error:",
        "Operation aborted",
        "Command exited with code",
        "Command timed out after",
        "Bash output exceeded the 10MB safety cap",
    ].some((marker) => content.includes(marker));
}

async function executeBuiltInTool(name: string, args: ToolArgs, signal?: AbortSignal) {
    if (signal?.aborted) throw Error("Operation aborted");
    if (name === "bash") {
        if (!args.command) throw Error("command is required");
        const timeout = args.timeout ?? 120;
        if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
            throw Error("timeout must be a positive number of seconds");
        let stdout = "",
            stderr = "";
        try {
            ({ stdout, stderr } = await run(args.command, {
                cwd: root,
                timeout: timeout * 1_000,
                maxBuffer: 10_000_000,
                signal,
            }));
        } catch (error) {
            if (signal?.aborted) throw Error("Operation aborted");
            const commandError = error as ExecException & { stdout?: string; stderr?: string };
            stdout = commandError.stdout ?? "";
            stderr = commandError.stderr ?? "";
            if (commandError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
                return limitBashOutput(
                    `${stdout}${stderr}${stdout || stderr ? "\n\n" : ""}Bash output exceeded the 10MB safety cap; complete output was not captured.`,
                    false,
                );
            if (commandError.killed)
                return limitBashOutput(
                    `${stdout}${stderr}${stdout || stderr ? "\n\n" : ""}Command timed out after ${timeout} seconds.`,
                );
            const code = typeof commandError.code === "number" ? commandError.code : "unknown";
            return limitBashOutput(
                `${stdout}${stderr}${stdout || stderr ? "\n\n" : ""}Command exited with code ${code}`,
            );
        }
        return limitBashOutput(stdout + stderr || "(no output)");
    }
    if (!args.path) throw Error("path is required");
    const path = pathInRoot(args.path);
    if (name === "read") {
        const text = await readFile(path, { encoding: "utf8", signal });
        return readLines(text, args.offset, args.limit);
    }
    if (name === "write") {
        if (args.content === undefined) throw Error("content is required");
        await mkdir(dirname(path), { recursive: true });
        if (signal?.aborted) throw Error("Operation aborted");
        await writeFile(path, args.content, { signal });
        return `Successfully wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}.`;
    }
    if (name === "edit") {
        if (!args.edits?.length) throw Error("edits must be a nonempty array");
        const original = await readFile(path, { encoding: "utf8", signal }),
            bom = original.startsWith("\uFEFF"),
            text = bom ? original.slice(1) : original,
            ending = text.match(/\r\n|\n/)?.[0] ?? "\n";
        let normalized = "",
            source = 0;
        const positions = [0];
        while (source < text.length) {
            if (text.startsWith("\r\n", source)) {
                normalized += "\n";
                source += 2;
            } else {
                normalized += text[source++];
            }
            positions.push(source);
        }
        const ranges = args.edits.map((edit, index) => {
            const oldText = edit.oldText.replace(/\r\n/g, "\n");
            if (!oldText) throw Error(`edits[${index}].oldText must not be empty`);
            const start = normalized.indexOf(oldText),
                second = start < 0 ? -1 : normalized.indexOf(oldText, start + 1);
            if (start < 0) throw Error(`edits[${index}].oldText was not found in ${args.path}.`);
            if (second >= 0)
                throw Error(`edits[${index}].oldText occurs more than once in ${args.path}; add more context.`);
            return {
                index,
                start: positions[start],
                end: positions[start + oldText.length],
                newText: edit.newText.replace(/\r\n|\n/g, ending),
            };
        });
        const sorted = [...ranges].sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].start >= sorted[i - 1].end) continue;
            throw Error(`edits[${sorted[i - 1].index}] and edits[${sorted[i].index}] overlap in ${args.path}.`);
        }
        let edited = text;
        for (const range of [...ranges].sort((a, b) => b.start - a.start))
            edited = edited.slice(0, range.start) + range.newText + edited.slice(range.end);
        if (bom) edited = "\uFEFF" + edited;
        if (signal?.aborted) throw Error("Operation aborted");
        await writeFile(path, edited, { signal });
        return `Successfully replaced ${args.edits.length} block(s) in ${args.path}.`;
    }
    throw Error(`unknown tool: ${name}`);
}

export async function executeTool(name: string, args: ToolArgs, signal?: AbortSignal) {
    const tool = builtInTools.find((candidate) => candidate.name === name);
    if (!tool) throw Error(`unknown tool: ${name}`);
    return tool.execute(args, signal);
}
