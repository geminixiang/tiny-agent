import { readFile } from "node:fs/promises";

const defaults = {
    port: 3000,
    host: "127.0.0.1",
    features: [],
};

export async function loadConfig(path, env = process.env) {
    const text = await readFile(path, "utf8");
    const fileConfig = JSON.parse(text);

    return {
        port: fileConfig.port || defaults.port,
        host: fileConfig.host || defaults.host,
        features: fileConfig.features || defaults.features,
    };
}
