export async function mapConcurrent(items, limit, worker, options = {}) {
    return Promise.all(items.map((item, index) => worker(item, index, options.signal)));
}
