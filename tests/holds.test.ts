import { describe, expect, it } from 'vitest';
import { isRetryableHold, parseHoldReleaseArgs, planHoldRelease, RETRYABLE_HOLD_REASONS, type HoldRow, } from '../src/pipeline/holds.js';
let nextId = 1;
function hold(over: Partial<HoldRow> = {}): HoldRow {
    return {
        id: nextId++,
        subject_kind: 'prospect',
        subject_id: 100 + nextId,
        stage: 'score',
        reason: 'transport',
        detail: null,
        created_at: new Date('2026-09-02T00:00:00Z'),
        ...over,
    };
}
describe('what a timer may release', () => {
    it('releases transport and timeout — those are blips, not verdicts', () => {
        expect(isRetryableHold(hold({ reason: 'transport' }))).toBe(true);
        expect(isRetryableHold(hold({ reason: 'timeout' }))).toBe(true);
        expect(isRetryableHold(hold({ reason: 'transport', detail: { detail: 'claude exited 1: invalid OAuth token' } }))).toBe(true);
    });
    it('never releases a judgement about the model OUTPUT — retrying re-buys the answer', () => {
        expect(isRetryableHold(hold({ reason: 'malformed' }))).toBe(false);
        expect(isRetryableHold(hold({ reason: 'refusal' }))).toBe(false);
        expect(isRetryableHold(hold({ reason: 'assessment count mismatch' }))).toBe(false);
    });
    it('matches on the detail too, because the stored reason is not always the bare kind', () => {
        const wrapped = hold({ reason: 'scorer requested hold', detail: { holdKind: 'timeout' } });
        expect(isRetryableHold(wrapped)).toBe(true);
    });
    it('lists only infrastructure failures, including subscription exhaustion', () => {
        expect([...RETRYABLE_HOLD_REASONS]).toEqual(['transport', 'timeout', 'rate_limit']);
    });
});
describe('planHoldRelease', () => {
    it('re-queues prospects and merely resolves seed/post holds', () => {
        const holds = [
            hold({ subject_kind: 'prospect', subject_id: 1, stage: 'score', reason: 'transport' }),
            hold({ subject_kind: 'seed_account', subject_id: 7, stage: 'scrape', reason: 'actor error' }),
            hold({ subject_kind: 'post', subject_id: 9, stage: 'scrape', reason: 'actor error' }),
        ];
        const score = planHoldRelease(holds, { stage: 'score', reasons: ['transport', 'timeout'] });
        expect(score.prospectIds).toEqual([1]);
        expect(score.holdIds).toHaveLength(1);
        expect(score.resolvedOnly).toHaveLength(0);
        const scrape = planHoldRelease(holds, { stage: 'scrape', allOfKind: true });
        expect(scrape.prospectIds).toEqual([]);
        expect(scrape.resolvedOnly).toHaveLength(2);
        expect(scrape.holdIds).toHaveLength(2);
    });
    it('ANDs the stage and reason filters', () => {
        const holds = [
            hold({ stage: 'score', reason: 'transport', subject_id: 1 }),
            hold({ stage: 'score', reason: 'malformed', subject_id: 2 }),
            hold({ stage: 'scrape', reason: 'transport', subject_id: 3 }),
        ];
        const plan = planHoldRelease(holds, { stage: 'score', reasons: ['transport'] });
        expect(plan.prospectIds).toEqual([1]);
        expect(plan.skipped).toHaveLength(2);
    });
    it('does nothing at all without a reason filter or --all-of-kind', () => {
        const plan = planHoldRelease([hold(), hold()], { stage: 'score' });
        expect(plan.holdIds).toEqual([]);
        expect(plan.skipped).toHaveLength(2);
        expect(plan.skipped[0]!.reason).toContain('--all-of-kind');
    });
    it('--all-of-kind releases the whole stage, reason notwithstanding', () => {
        const holds = [
            hold({ stage: 'score', reason: 'transport', subject_id: 1 }),
            hold({ stage: 'score', reason: 'malformed', subject_id: 2 }),
        ];
        const plan = planHoldRelease(holds, { stage: 'score', allOfKind: true });
        expect(plan.prospectIds).toEqual([1, 2]);
    });
    it('an absent stage means every stage', () => {
        const holds = [
            hold({ stage: 'score', reason: 'timeout', subject_id: 1 }),
            hold({ stage: 'draft', reason: 'timeout', subject_id: 2 }),
        ];
        expect(planHoldRelease(holds, { reasons: ['timeout'] }).prospectIds).toEqual([1, 2]);
    });
    it('deduplicates a prospect held more than once', () => {
        const holds = [
            hold({ subject_id: 42, reason: 'transport' }),
            hold({ subject_id: 42, reason: 'timeout' }),
        ];
        const plan = planHoldRelease(holds, { reasons: ['transport', 'timeout'] });
        expect(plan.prospectIds).toEqual([42]);
        expect(plan.holdIds).toHaveLength(2);
    });
    it('is case-insensitive about the reason', () => {
        expect(planHoldRelease([hold({ reason: 'TRANSPORT' })], { reasons: ['transport'] }).holdIds)
            .toHaveLength(1);
    });
});
describe('CLI argument parsing', () => {
    it('parses the invocation from the runbook', () => {
        expect(parseHoldReleaseArgs(['--stage', 'score', '--reason', 'transport,timeout'])).toEqual({
            stage: 'score',
            reasons: ['transport', 'timeout'],
            allOfKind: false,
            dryRun: false,
        });
    });
    it('accepts the = form and --all-of-kind and --dry-run', () => {
        expect(parseHoldReleaseArgs(['--stage=scrape', '--all-of-kind', '--dry-run'])).toEqual({
            stage: 'scrape',
            reasons: [],
            allOfKind: true,
            dryRun: true,
        });
    });
    it('tolerates whitespace and empty entries in the reason list', () => {
        expect(parseHoldReleaseArgs(['--reason', ' transport , ,timeout ']).reasons).toEqual([
            'transport',
            'timeout',
        ]);
    });
});
