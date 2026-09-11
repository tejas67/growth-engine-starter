import { describe, expect, it } from 'vitest';
import { drain } from '../src/pipeline/drain.js';
describe('drain', () => {
    it('runs batches until the stage reports no work', async () => {
        const seq = [{ scored: 10, held: 0, preFiltered: 0 }, { scored: 3, held: 1, preFiltered: 2 }, { scored: 0, held: 0, preFiltered: 0 }];
        let t = 0;
        const r = await drain(async () => seq.shift()!, 60000, () => (t += 1000));
        expect(r).toMatchObject({ batches: 3, scored: 13, held: 1, preFiltered: 2, budgetHit: false });
    });
    it('stops when a batch only held rows (no spin on the model)', async () => {
        const seq = [{ scored: 5, held: 0, preFiltered: 0 }, { scored: 0, held: 10, preFiltered: 0 }, { scored: 9, held: 0, preFiltered: 0 }];
        const r = await drain(async () => seq.shift()!, 60000);
        expect(r.batches).toBe(2);
        expect(r.scored).toBe(5);
    });
    it('stops when the wall-clock budget is spent', async () => {
        let t = 0;
        const r = await drain(async () => ({ scored: 1, held: 0, preFiltered: 0 }), 5000, () => (t += 3000));
        expect(r.budgetHit).toBe(true);
        expect(r.batches).toBeGreaterThanOrEqual(1);
        expect(r.batches).toBeLessThanOrEqual(3);
    });
});
