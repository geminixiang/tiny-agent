import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { environmentIdentityOverride } from "./env.js";
import { reduceSession, type SessionState } from "./session-reducer.js";

export type SessionFact = Record<string, unknown>;
export type SessionFactInput = Omit<SessionFact, "seq" | "timestamp"> & { id?: string };

const writers = new Set<string>();

// prettier-ignore
export function uuid7(now = Date.now()) { const bytes = randomBytes(16); let time = BigInt(now); for (let index = 5; index >= 0; index--) { bytes[index] = Number(time & 0xffn); time >>= 8n; } bytes[6] = (bytes[6] & 15) | 0x70; bytes[8] = (bytes[8] & 63) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }

export async function environmentIdentity(cwd: string) {
    return environmentIdentityOverride() || (await realpath(cwd));
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
        const requestedDirectory = resolve(cwd, ".tiny-agent/sessions");
        await mkdir(requestedDirectory, { recursive: true });
        const directory = await realpath(requestedDirectory);
        const path = resolve(directory, `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
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
            await handle.chmod(0o600);
            const bytes = Buffer.from(header);
            const state = reduceSession(bytes);
            writers.add(path);
            return new SessionStore(id, path, handle, bytes, 1, state);
        } catch (error) {
            await handle.close();
            throw error;
        }
    }

    static async open(id: string, cwd: string) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
            throw Error(`Invalid session ID: ${id}`);
        const requestedDirectory = resolve(cwd, ".tiny-agent/sessions");
        const directory = await realpath(requestedDirectory).catch(() => {
            throw Error(`Session not found: ${id}`);
        });
        const matches = (await readdir(directory, { withFileTypes: true })).filter(
            (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(`_${id}.jsonl`),
        );
        if (matches.length !== 1)
            throw Error(matches.length ? `Duplicate session ID: ${id}` : `Session not found: ${id}`);
        const path = resolve(directory, matches[0].name);
        if (dirname(await realpath(path)) !== directory) throw Error(`Unsafe session path: ${id}`);
        if (writers.has(path)) throw Error(`Session is already open for writing: ${id}`);
        writers.add(path);
        let handle: Awaited<ReturnType<typeof open>>;
        try {
            handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
        } catch (error) {
            writers.delete(path);
            throw error;
        }
        try {
            let bytes = await handle.readFile();
            const state = reduceSession(bytes);
            if (state.header.id !== id) throw Error("session filename does not match header");
            if (state.repairedLength !== bytes.length) {
                await handle.truncate(state.repairedLength);
                bytes = bytes.subarray(0, state.repairedLength);
            }
            await handle.chmod(0o600);
            return new SessionStore(id, path, handle, bytes, countFacts(bytes) + 1, reduceSession(bytes));
        } catch (error) {
            writers.delete(path);
            await handle.close();
            throw error;
        }
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

    async facts() {
        await this.queue;
        const lines = new TextDecoder("utf8", { fatal: true }).decode(this.bytes).trimEnd().split("\n").slice(1);
        return lines.flatMap((line) => {
            const transaction = JSON.parse(line) as SessionFact | SessionFact[];
            return Array.isArray(transaction) ? transaction : [transaction];
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
