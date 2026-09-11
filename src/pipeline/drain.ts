export interface BatchResult {
    scored?: number;
    held?: number;
    preFiltered?: number;
}
export async function drain<T extends BatchResult>(runBatch: () => Promise<T>, budgetMs: number, now: () => number = Date.now): Promise<{
    batches: number;
    scored: number;
    held: number;
    preFiltered: number;
    budgetHit: boolean;
}> {
    const deadline = now() + budgetMs;
    const total = { batches: 0, scored: 0, held: 0, preFiltered: 0, budgetHit: false };
    for (;;) {
        const r = await runBatch();
        total.batches += 1;
        total.scored += r.scored ?? 0;
        total.held += r.held ?? 0;
        total.preFiltered += r.preFiltered ?? 0;
        const didWork = (r.scored ?? 0) + (r.held ?? 0) + (r.preFiltered ?? 0);
        if (didWork === 0)
            break;
        if ((r.scored ?? 0) === 0 && (r.preFiltered ?? 0) === 0)
            break;
        if (now() >= deadline) {
            total.budgetHit = true;
            break;
        }
    }
    return total;
}
