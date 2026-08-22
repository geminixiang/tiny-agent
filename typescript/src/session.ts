import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, realpath, truncate } from "node:fs/promises";
import { resolve } from "node:path";
import { reduceSession, type SessionState } from "./session-reducer.js";

export type SessionFact = Record<string, unknown>;
export type SessionFactInput = Omit<SessionFact, "seq" | "timestamp"> & { id?: string };

const writers = new Set<string>();

// prettier-ignore
export function uuid7(now = Date.now()) { const bytes = randomBytes(16); let time = BigInt(now); for (let index = 5; index >= 0; index--) { bytes[index] = Number(time & 0xffn); time >>= 8n; } bytes[6] = (bytes[6] & 15) | 0x70; bytes[8] = (bytes[8] & 63) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }

export async function environmentIdentity(cwd: string) {
    return process.env.TINY_AGENT_ENVIRONMENT_IDENTITY?.trim() || (await realpath(cwd));
}

function countFacts(bytes: Uint8Array) {
    const lines = new TextDecoder("utf8", { fatal: true }).decode(bytes).trimEnd().split("\n").slice(1);
    return lines.reduce((count, line) => {
        const transaction: unknown = JSON.parse(line);
        return count + (Array.isArray(transaction) ? transaction.length : 1);
    }, 0);
}

export class SessionStore {
    private queue = Promise.resolve();
    private closed = false;

    private constructor(
        public readonly id: string,
        public readonly path: string,
        private handle: Awaited<ReturnType<typeof open>>,
        private bytes: Uint8Array,
        private nextSeq: number,
        private state: SessionState,
    ) {}

    static async create(cwd: string, model: string, now = new Date()) {
        const id = uuid7(now.getTime());
        const directory = resolve(cwd, ".tiny-agent/sessions");
        const path = resolve(directory, `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
        await mkdir(directory, { recursive: true });
        const header = `${JSON.stringify({
            kind: "header",
            version: 2,
            id,
            createdAt: now.getTime(),
            cwd,
            provider: "openrouter",
            model,
            environmentIdentity: await environmentIdentity(cwd),
        })}\n`;
        const handle = await open(path, "wx", 0o600);
        try {
            await handle.writeFile(header);
            await chmod(path, 0o600);
            const bytes = Buffer.from(header);
            writers.add(path);
            return new SessionStore(id, path, handle, bytes, 1, reduceSession(bytes));
        } catch (error) {
            await handle.close();
            throw error;
        }
    }

    static async open(id: string, cwd: string) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
            throw Error(`Invalid session ID: ${id}`);
        const directory = resolve(cwd, ".tiny-agent/sessions");
        const matches = (await readdir(directory).catch(() => [])).filter((file) => file.endsWith(`_${id}.jsonl`));
        if (matches.length !== 1)
            throw Error(matches.length ? `Duplicate session ID: ${id}` : `Session not found: ${id}`);
        const path = resolve(directory, matches[0]);
        if (writers.has(path)) throw Error(`Session is already open for writing: ${id}`);
        let bytes = await readFile(path);
        const state = reduceSession(bytes);
        if (state.repairedLength !== bytes.length) {
            await truncate(path, state.repairedLength);
            bytes = bytes.subarray(0, state.repairedLength);
        }
        const handle = await open(path, "a", 0o600);
        await chmod(path, 0o600);
        writers.add(path);
        return new SessionStore(id, path, handle, bytes, countFacts(bytes) + 1, reduceSession(bytes));
    }

    allocateId() {
        return uuid7();
    }

    async append(input: SessionFactInput | SessionFactInput[]) {
        const values = Array.isArray(input) ? input : [input];
        if (!values.length) throw Error("Session transaction must not be empty");
        return this.enqueue(async () => {
            const timestamp = Date.now();
            const facts = values.map((value, index) => ({
                ...value,
                id: value.id ?? uuid7(),
                seq: this.nextSeq + index,
                timestamp,
            }));
            const line = `${JSON.stringify(facts.length === 1 ? facts[0] : facts)}\n`;
            const candidate = Buffer.concat([this.bytes, Buffer.from(line)]);
            const state = reduceSession(candidate);
            await this.handle.writeFile(line);
            this.bytes = candidate;
            this.nextSeq += facts.length;
            this.state = state;
            return facts;
        });
    }

    async load() {
        await this.queue;
        return this.state;
    }

    async close() {
        await this.queue;
        if (this.closed) return;
        this.closed = true;
        writers.delete(this.path);
        await this.handle.close();
    }

    private async enqueue<T>(operation: () => Promise<T>) {
        let resolve!: (value: T) => void;
        let reject!: (reason: unknown) => void;
        const result = new Promise<T>((ok, fail) => {
            resolve = ok;
            reject = fail;
        });
        const run = async () => {
            try {
                if (this.closed) throw Error("Session is closed");
                resolve(await operation());
            } catch (error) {
                reject(error);
            }
        };
        this.queue = this.queue.then(run, run);
        await result;
        return result;
    }
}
