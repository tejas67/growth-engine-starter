import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkFrequencyCap, type TouchRecord, } from '../src/guardrails/frequency_cap.js';
import { emailLaneAdmits, evaluateBounceTripwire, type SendRecord, } from '../src/guardrails/bounce_tripwire.js';
import { assessGov, coldEmailAllowed } from '../src/guardrails/gov_gate.js';
import { decide, zeroDayVerdict } from '../src/guardrails/spend_governor.js';
import { admitsToDmLane, prioritizeDmQueue, rationDmQueue, routeFor, type DmCandidate } from '../src/guardrails/ramp.js';
const NOW = new Date('2026-08-15T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86400000);
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});
function sent(id: number, channel: TouchRecord['channel'], at: Date): TouchRecord {
    return { id, prospectId: 1, channel, sentAt: at, status: 'sent' };
}
describe('90-day cross-channel frequency cap', () => {
    it('allows a first touch', () => {
        const decision = checkFrequencyCap([], NOW);
        expect(decision.allowed).toBe(true);
    });
    it('allows the rest of an OPEN sequence', () => {
        const decision = checkFrequencyCap([sent(1, 'email', daysAgo(3))], NOW);
        expect(decision.allowed).toBe(true);
        if (decision.allowed)
            expect(decision.reason).toBe('within_open_sequence');
    });
    it('stops at three touches inside one sequence (1 email + 2 DMs)', () => {
        const decision = checkFrequencyCap([sent(1, 'email', daysAgo(8)), sent(2, 'dm', daysAgo(5)), sent(3, 'dm', daysAgo(2))], NOW);
        expect(decision.allowed).toBe(false);
        if (!decision.allowed)
            expect(decision.reason).toBe('sequence_touch_limit');
    });
    it('BLOCKS a second sequence inside 90 days — the cap is cross-channel', () => {
        const decision = checkFrequencyCap([sent(1, 'email', daysAgo(40))], NOW);
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) {
            expect(decision.reason).toBe('sequence_cap_90d');
            expect(decision.detail).toContain('all channels and aliases');
        }
    });
    it('allows a fresh sequence once the full window has passed', () => {
        const decision = checkFrequencyCap([sent(1, 'dm', daysAgo(95))], NOW);
        expect(decision.allowed).toBe(true);
    });
    it('is OR-resolved: touches inherited from a merged alias still count', () => {
        const inherited: TouchRecord[] = [
            { id: 88, prospectId: 10, channel: 'dm', sentAt: daysAgo(30), status: 'sent' },
        ];
        const decision = checkFrequencyCap(inherited, NOW);
        expect(decision.allowed).toBe(false);
    });
    it('drafts and skips do not consume the cap — only real sends do', () => {
        const notSent: TouchRecord[] = [
            { id: 1, prospectId: 1, channel: 'dm', sentAt: null, status: 'draft' },
            { id: 2, prospectId: 1, channel: 'email', sentAt: null, status: 'skipped' },
        ];
        expect(checkFrequencyCap(notSent, NOW).allowed).toBe(true);
    });
});
describe('bounce tripwire — armed from send #1', () => {
    const send = (id: number, bounced: boolean, dayOffset: number): SendRecord => ({
        touchId: id,
        sentAt: daysAgo(dayOffset),
        hardBouncedAt: bounced ? daysAgo(dayOffset - 0.5) : null,
    });
    it('does not trip on two bounces', () => {
        const state = evaluateBounceTripwire([send(1, true, 5), send(2, true, 4), send(3, false, 3)], NOW);
        expect(state.tripped).toBe(false);
        expect(state.hardBounces).toBe(2);
    });
    it('TRIPS on three bounces inside the first twenty sends', () => {
        const sends = [
            ...Array.from({ length: 17 }, (_, i) => send(i + 1, false, 10)),
            send(18, true, 5),
            send(19, true, 4),
            send(20, true, 3),
        ];
        const state = evaluateBounceTripwire(sends, NOW);
        expect(state.tripped).toBe(true);
        expect(state.sendsConsidered).toBe(20);
        expect(state.reason).toContain('restricted to verified-good');
    });
    it('only looks at the most recent 100 sends', () => {
        const old = Array.from({ length: 5 }, (_, i) => send(i + 1, true, 300 - i));
        const recent = Array.from({ length: 100 }, (_, i) => send(200 + i, false, 50 - i * 0.1));
        const state = evaluateBounceTripwire([...old, ...recent], NOW);
        expect(state.tripped).toBe(false);
        expect(state.sendsConsidered).toBe(100);
    });
    it('ignores bounces that have not arrived yet — replayable at any point in time', () => {
        const future: SendRecord[] = [
            { touchId: 1, sentAt: daysAgo(5), hardBouncedAt: new Date(NOW.getTime() + 86400000) },
            { touchId: 2, sentAt: daysAgo(5), hardBouncedAt: daysAgo(4) },
            { touchId: 3, sentAt: daysAgo(5), hardBouncedAt: daysAgo(4) },
        ];
        expect(evaluateBounceTripwire(future, NOW).hardBounces).toBe(2);
    });
    it('restricts catchalls once tripped, and never sends to invalid in either mode', () => {
        expect(emailLaneAdmits('all', 'catchall')).toBe(true);
        expect(emailLaneAdmits('good_only', 'catchall')).toBe(false);
        expect(emailLaneAdmits('all', 'good')).toBe(true);
        expect(emailLaneAdmits('all', 'invalid')).toBe(false);
        expect(emailLaneAdmits('good_only', 'invalid')).toBe(false);
    });
    it('treats an unverified or risky address exactly like a catchall (F7)', () => {
        expect(emailLaneAdmits('all', 'unverified')).toBe(true);
        expect(emailLaneAdmits('all', 'risky')).toBe(true);
        expect(emailLaneAdmits('all', null)).toBe(true);
        expect(emailLaneAdmits('good_only', 'unverified')).toBe(false);
        expect(emailLaneAdmits('good_only', 'risky')).toBe(false);
        expect(emailLaneAdmits('good_only', null)).toBe(false);
    });
});
describe('gov gate — fails CLOSED', () => {
    it('blocks a .mil or .gov mailbox outright', () => {
        expect(assessGov({ email: 'someone@navy.mil' }).isGov).toBe(true);
        expect(coldEmailAllowed({ email: 'someone@gsa.gov' }).allowed).toBe(false);
    });
    it('blocks persona P4 regardless of anything else', () => {
        const result = coldEmailAllowed({ email: 'personal@gmail.com', persona: 'P4' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('founder-touch list');
    });
    it('recognises a named command or agency in the employer', () => {
        expect(assessGov({ headline: 'Program Manager at AFRL' }).isGov).toBe(true);
        expect(assessGov({ headline: 'Contracting Officer, NAVSEA' }).isGov).toBe(true);
    });
    it('treats a gov-SHAPED title as ambiguous, and ambiguous refuses cold email', () => {
        const verdict = assessGov({ headline: 'Deputy Director' });
        expect(verdict.ambiguous).toBe(true);
        expect(coldEmailAllowed({ headline: 'Deputy Director' }).allowed).toBe(false);
    });
    it('refuses when there is nothing at all to judge on', () => {
        expect(coldEmailAllowed({}).allowed).toBe(false);
    });
    it('allows an ordinary industry prospect', () => {
        const result = coldEmailAllowed({
            email: 'jordan@sample-services.example',
            headline: 'Founder of sample-services.example',
            persona: 'P1',
        });
        expect(result.allowed).toBe(true);
    });
});
describe('spend governor — degrades cadence, never coverage', () => {
    const plenty = { spentTodayUsd: 0, capUsd: 6 };
    const nearlyGone = { spentTodayUsd: 5.9, capUsd: 6 };
    const exhausted = { spentTodayUsd: 6, capUsd: 6 };
    it('runs a fresh post on the normal cadence when there is budget', () => {
        const decision = decide({ kind: 'engagers', estimatedResults: 80, postAgeHours: 3, minutesSinceLastScrape: 60 }, plenty);
        expect(decision.proceed).toBe(true);
        expect(decision.reason).toBe('ok');
    });
    it('stretches the interval under budget pressure instead of dropping the target', () => {
        const decision = decide({ kind: 'engagers', estimatedResults: 80, postAgeHours: 3, minutesSinceLastScrape: 60 }, nearlyGone);
        expect(decision.proceed).toBe(false);
        expect(decision.reason).toBe('cadence_backoff');
        expect(decision.degradedIntervalMinutes).toBeGreaterThan(45);
    });
    it('stops billing once the cap is truly gone', () => {
        const decision = decide({ kind: 'engagers', estimatedResults: 80, postAgeHours: 3, minutesSinceLastScrape: 10000 }, exhausted);
        expect(decision.proceed).toBe(false);
        expect(decision.reason).toBe('budget_exhausted');
    });
    it('EXEMPTS the day-4 retirement snapshot even when the cap is blown', () => {
        const decision = decide({ kind: 'retirement_snapshot', estimatedResults: 300, postAgeHours: 96, minutesSinceLastScrape: 5 }, exhausted);
        expect(decision.proceed).toBe(true);
        expect(decision.reason).toBe('exempt');
    });
    it('polls a tail post less often than a fresh one', () => {
        const fresh = decide({ kind: 'engagers', estimatedResults: 10, postAgeHours: 2, minutesSinceLastScrape: 50 }, plenty);
        const tail = decide({ kind: 'engagers', estimatedResults: 10, postAgeHours: 48, minutesSinceLastScrape: 50 }, plenty);
        expect(fresh.proceed).toBe(true);
        expect(tail.proceed).toBe(false);
    });
    it('polls a dormant seed account weekly instead of every two hours', () => {
        const sixHoursSince = { kind: 'posts' as const, estimatedResults: 10, postAgeHours: null, minutesSinceLastScrape: 360 };
        const active = decide({ ...sixHoursSince, cadenceClass: 'active' }, plenty);
        const dormant = decide({ ...sixHoursSince, cadenceClass: 'dormant' }, plenty);
        expect(active.proceed).toBe(true);
        expect(dormant.proceed).toBe(false);
        expect(dormant.reason).toBe('too_soon');
        const aWeekLater = decide({ ...sixHoursSince, cadenceClass: 'dormant', minutesSinceLastScrape: 10081 }, plenty);
        expect(aWeekLater.proceed).toBe(true);
    });
    it('zeroDayVerdict and the governor together separate a quiet day from a dead slug', () => {
        expect(zeroDayVerdict(0, false, 3).flagged).toBe(false);
        expect(zeroDayVerdict(5, false, 3).flagged).toBe(true);
    });
});
describe('DM lane admission and rationing (F5)', () => {
    const base: DmCandidate = {
        prospectId: 1,
        persona: 'P2',
        score: 60,
        hasComment: false,
        signalCount: 1,
        detectedAt: daysAgo(1),
        isConnected: false,
        isOpenProfile: false,
        looksLikeSpam: false,
    };
    it('admits everyone except P0 and obvious spam — no score floors', () => {
        expect(admitsToDmLane({ ...base, score: 12 })).toBe(true);
        expect(admitsToDmLane({ ...base, persona: 'P0' })).toBe(false);
        expect(admitsToDmLane({ ...base, looksLikeSpam: true })).toBe(false);
    });
    it('orders hot commenters first, P1 before P2 before P3', () => {
        const queue = prioritizeDmQueue([
            { ...base, prospectId: 1, persona: 'P3', hasComment: true },
            { ...base, prospectId: 2, persona: 'P1', hasComment: true },
            { ...base, prospectId: 3, persona: 'P1', hasComment: false, signalCount: 3 },
            { ...base, prospectId: 4, persona: 'P2', hasComment: true },
        ]);
        expect(queue.map((c) => c.prospectId)).toEqual([2, 4, 1, 3]);
    });
    it('routes existing connections and open profiles to a direct DM', () => {
        expect(routeFor({ ...base, isConnected: true })).toBe('dm');
        expect(routeFor({ ...base, isOpenProfile: true })).toBe('dm');
        expect(routeFor(base)).toBe('connect');
    });
    it('defers overflow rather than dropping it — the queue reaches deeper on a quiet day', () => {
        const candidates = Array.from({ length: 20 }, (_, i) => ({
            ...base,
            prospectId: i + 1,
            isConnected: true,
        }));
        const rationed = rationDmQueue(candidates, { invitesPerDay: 10, dmsPerDay: 15, phase: 'week1' });
        expect(rationed.dms.length).toBe(15);
        expect(rationed.deferred.length).toBe(5);
        expect(rationed.dms.length + rationed.deferred.length).toBe(20);
    });
    it('a paused campaign defers everything, losing nothing', () => {
        const rationed = rationDmQueue([base], { invitesPerDay: 10, dmsPerDay: 15, phase: 'paused' });
        expect(rationed.dms).toHaveLength(0);
        expect(rationed.deferred).toHaveLength(1);
    });
});
