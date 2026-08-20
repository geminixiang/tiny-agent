#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface, emitKeypressEvents } from "node:readline";
import { Agent, MODEL, Session, loadProjectInstructions, loadSkills, formatToolEvent, formatUsage } from "./index.js";

async function main() {
    const args = process.argv.slice(2),
        value = (flag: string) => args[args.indexOf(flag) + 1],
        sessionId = value("--session");
    if (args.includes("--session") && !sessionId) throw Error("--session requires a UUIDv7");
    const extras = args.flatMap((x, i) => (x === "--skill" && args[i + 1] ? [args[i + 1]] : [])),
        skills = await loadSkills(extras),
        instructions = await loadProjectInstructions();
    const session = sessionId ? await Session.open(sessionId) : await Session.create();
    const showTool = (event: Parameters<typeof formatToolEvent>[0]) =>
        console.log(`\x1b[${event.phase === "start" ? "33" : "2"}m${formatToolEvent(event)}\x1b[0m`);
    const agent = new Agent(skills, fetch, session, showTool, instructions);
    if (sessionId) await agent.resumeSession();
    const oneShot = args
        .filter((x, i) => !["--skill", "--session"].includes(x) && !["--skill", "--session"].includes(args[i - 1]))
        .join(" ");
    const resume = () => console.log(`\nResume: tiny-ts --session ${session.id}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout }),
        ask = (q: string) => new Promise<string>((ok) => rl.question(q, ok));
    emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    let exiting = false;
    const onKeypress = (_: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
        if ((key.ctrl || key.meta) && key.name === "c") {
            exiting = true;
            if (agent.busy) agent.abort();
            else rl.write("/exit\n");
            return;
        }
        if (key.name !== "escape" || !agent.busy) return;
        console.log("\n\x1b[33mAborting...\x1b[0m");
        agent.abort();
    };
    process.stdin.on("keypress", onKeypress);
    const close = () => {
        process.stdin.off("keypress", onKeypress);
        rl.close();
        resume();
    };
    console.log(
        `\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nmodel: ${MODEL}\nsession: ${session.id}\npath: ${session.path}${sessionId ? "\nrestored: yes" : ""}`,
    );
    if (oneShot) {
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
