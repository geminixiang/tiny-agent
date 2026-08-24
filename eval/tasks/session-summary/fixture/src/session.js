export function summarizeEvents(events) {
    return {
        total: events.length,
        byType: {},
        durationMs: 0,
    };
}
