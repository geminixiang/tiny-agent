export function memoizeAsync(load, options = {}) {
    const ttlMs = options.ttlMs ?? 60_000;
    const cache = new Map();

    return async function cached(key) {
        const now = Date.now();
        const existing = cache.get(key);
        if (existing && now - existing.createdAt < ttlMs) {
            return existing.value;
        }

        const value = await load(key);
        cache.set(key, { value, createdAt: now });
        return value;
    };
}
