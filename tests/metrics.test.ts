import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFunnel, cutBy, graduationVerdicts, SELECTION_BIAS_NOTE, type EventFact, type TouchFact, } from '../src/metrics/funnels.js';
const NOW = new Date('2026-08-15T12:00:00.000Z');
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});
function touch(id: number, overrides: Partial<TouchFact> = {}): TouchFact {
    return {
        touchId: id,
        prospectId: id,
        channel: 'dm',
        persona: 'P1',
        templateVersion: 'A-hw@v2',
        angle: 'A1',
        seedAccountId: 1,
        signalType: 'like',
        latencyBucket: '1-4h',
        matchCount: null,
        founderEdited: false,
        sentAt: NOW,
        dryRun: false,
        ...overrides,
    };
}
const reply = (touchId: number, kind: string): EventFact => ({
    touchId,
    prospectId: touchId,
    kind,
    occurredAt: NOW,
});
describe('honest empty states', () => {
    it('shows NO rates when a lane is below the reporting floor', () => {
        const funnel = buildFunnel('dm', [touch(1), touch(2), touch(3)], [reply(1, 'reply')], 10);
        expect(funnel.n).toBe(3);
        expect(funnel.belowFloor).toBe(true);
        expect(funnel.note).toContain('below the 10-send reporting floor');
        expect(funnel.stages.find((s) => s.name === 'sent')!.count).toBe(3);
        expect(funnel.stages.find((s) => s.name === 'reply')!.count).toBe(1);
        expect(funnel.stages.every((s) => s.rate === null)).toBe(true);
    });
    it('shows rates once the denominator clears the floor', () => {
        const touches = Array.from({ length: 20 }, (_, i) => touch(i + 1));
        const events = [reply(1, 'reply'), reply(2, 'reply'), reply(3, 'reply'), reply(4, 'reply')];
        const funnel = buildFunnel('dm', touches, events, 10);
        expect(funnel.belowFloor).toBe(false);
        expect(funnel.stages.find((s) => s.name === 'reply')!.rate).toBeCloseTo(0.2);
    });
    it('never counts a dry-run touch as a send', () => {
        const funnel = buildFunnel('dm', [touch(1, { dryRun: true }), touch(2, { dryRun: true })], [], 10);
        expect(funnel.n).toBe(0);
    });
    it('keeps the two lanes separate — a claim is not a signup', () => {
        const email = buildFunnel('email', [touch(1, { channel: 'email' })], [], 1);
        const dm = buildFunnel('dm', [touch(2, { channel: 'dm' })], [], 1);
        expect(email.stages.map((s) => s.name)).toEqual(['sent', 'clicked', 'claimed', 'activated']);
        expect(dm.stages.map((s) => s.name)).toEqual(['sent', 'reply', 'positive_reply', 'signed_in']);
    });
    it('counts connection requests inside the DM lane', () => {
        const funnel = buildFunnel('dm', [touch(1, { channel: 'connect' }), touch(2, { channel: 'dm' })], [], 1);
        expect(funnel.n).toBe(2);
    });
});
describe('cuts', () => {
    it('EXCLUDES founder-edited sends — they measure the founder, not the template', () => {
        const touches = [
            touch(1, { founderEdited: false }),
            touch(2, { founderEdited: true }),
            touch(3, { founderEdited: true }),
        ];
        const cells = cutBy(touches, [], (t) => t.persona, 1);
        expect(cells).toHaveLength(1);
        expect(cells[0]!.sends).toBe(1);
    });
    it('cuts by persona — the predeclared primary cut', () => {
        const touches = [
            ...Array.from({ length: 12 }, (_, i) => touch(i + 1, { persona: 'P1' })),
            ...Array.from({ length: 12 }, (_, i) => touch(i + 100, { persona: 'P2' })),
        ];
        const events = [reply(1, 'positive_reply'), reply(2, 'positive_reply'), reply(100, 'reply')];
        const cells = cutBy(touches, events, (t) => t.persona, 10);
        const p1 = cells.find((c) => c.key === 'P1')!;
        const p2 = cells.find((c) => c.key === 'P2')!;
        expect(p1.positive).toBe(2);
        expect(p1.positiveRate).toBeCloseTo(2 / 12);
        expect(p2.positive).toBe(0);
        expect(p2.replies).toBe(1);
    });
    it('withholds the rate on a thin cell but still shows the counts', () => {
        const cells = cutBy([touch(1), touch(2)], [reply(1, 'positive_reply')], (t) => t.angle, 10);
        expect(cells[0]!.belowFloor).toBe(true);
        expect(cells[0]!.positiveRate).toBeNull();
        expect(cells[0]!.positive).toBe(1);
    });
    it('labels an unset dimension rather than dropping the rows', () => {
        const cells = cutBy([touch(1, { angle: null })], [], (t) => t.angle, 1);
        expect(cells[0]!.key).toBe('(unset)');
    });
});
describe('graduation — per template x persona, never aggregate', () => {
    it('says insufficient data below the send threshold', () => {
        const verdicts = graduationVerdicts(Array.from({ length: 10 }, (_, i) => touch(i + 1)), [], 50, 0.05);
        expect(verdicts[0]!.recommendation).toBe('insufficient_data');
        expect(verdicts[0]!.note).toContain('10/50 sends');
    });
    it('recommends graduation only when a SPECIFIC cell clears the bar', () => {
        const touches = Array.from({ length: 60 }, (_, i) => touch(i + 1, { persona: 'P1' }));
        const events = Array.from({ length: 5 }, (_, i) => reply(i + 1, 'positive_reply'));
        const verdicts = graduationVerdicts(touches, events, 50, 0.05);
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0]!.persona).toBe('P1');
        expect(verdicts[0]!.recommendation).toBe('graduate');
        expect(verdicts[0]!.note).toContain('Founder flips the switch');
    });
    it('does NOT let a template proven on P1 graduate on P2', () => {
        const touches = [
            ...Array.from({ length: 60 }, (_, i) => touch(i + 1, { persona: 'P1' })),
            ...Array.from({ length: 60 }, (_, i) => touch(i + 200, { persona: 'P2' })),
        ];
        const events = Array.from({ length: 6 }, (_, i) => reply(i + 1, 'positive_reply'));
        const verdicts = graduationVerdicts(touches, events, 50, 0.05);
        const p1 = verdicts.find((v) => v.persona === 'P1')!;
        const p2 = verdicts.find((v) => v.persona === 'P2')!;
        expect(p1.recommendation).toBe('graduate');
        expect(p2.recommendation).toBe('kill');
    });
    it('recommends a kill well below the bar and keep-testing just under it', () => {
        const make = (positives: number) => graduationVerdicts(Array.from({ length: 100 }, (_, i) => touch(i + 1)), Array.from({ length: positives }, (_, i) => reply(i + 1, 'positive_reply')), 50, 0.05)[0]!;
        expect(make(1).recommendation).toBe('kill');
        expect(make(4).recommendation).toBe('keep_testing');
        expect(make(5).recommendation).toBe('graduate');
    });
});
describe('the standing caveat', () => {
    it('names the selection bias rather than quietly carrying it', () => {
        expect(SELECTION_BIAS_NOTE).toContain('founder selection');
        expect(SELECTION_BIAS_NOTE).toContain('directional');
    });
});
