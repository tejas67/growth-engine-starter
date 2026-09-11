import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectedReply } from '../src/clients/imap.js';
import type { HeyReachReply } from '../src/clients/heyreach.js';
import { gmailThreadUrl, matchEmailReply, planDmReply, planEmailReply, planOutcomeSync, touchIdFromRef, type PlatformOutcome, type SentTouchIndex, } from '../src/pipeline/ingest.js';
const NOW = new Date('2026-08-15T12:00:00.000Z');
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});
function index(): SentTouchIndex {
    return {
        byMessageId: new Map([['<outbound-901@growth.example>', 901]]),
        byRecipient: new Map([['jordan@sample-services.example', [901]]]),
        byLinkedInUrl: new Map([['https://www.linkedin.com/in/alex-example', [902]]]),
        prospectOf: new Map([
            [901, 55],
            [902, 55],
        ]),
    };
}
function emailReply(overrides: Partial<DetectedReply> = {}): DetectedReply {
    return {
        messageId: '<reply-1@gmail.com>',
        inReplyTo: '<outbound-901@growth.example>',
        references: ['<outbound-901@growth.example>'],
        from: 'jordan@sample-services.example',
        subject: 'Re: 7 federal programs fit Sample Services',
        text: 'Interesting - send the list.',
        receivedAt: NOW,
        gmailThreadId: 'thread-abc',
        ...overrides,
    };
}
describe('email reply matching', () => {
    it('matches on the In-Reply-To chain — the strongest signal', () => {
        const match = matchEmailReply(emailReply(), index());
        expect(match).toEqual({ matched: true, touchId: 901, prospectId: 55, via: 'message_id' });
    });
    it('falls back to the sender address when the chain is missing', () => {
        const match = matchEmailReply(emailReply({ inReplyTo: null, references: [] }), index());
        expect(match.matched).toBe(true);
        if (match.matched)
            expect(match.via).toBe('recipient');
    });
    it('pauses the prospect the moment a reply is matched — any reply, not just a bad one', () => {
        const plan = planEmailReply(emailReply(), index());
        expect(plan.kind).toBe('reply');
        expect(plan.pauseProspectId).toBe(55);
        expect(plan.kind).not.toBe('positive_reply');
    });
    it('SURFACES an unmatched reply instead of dropping it', () => {
        const plan = planEmailReply(emailReply({ inReplyTo: null, references: [], from: 'stranger@example.com' }), index());
        expect(plan.kind).toBe('unmatched_reply');
        expect(plan.touchId).toBeNull();
        expect(plan.pauseProspectId).toBeNull();
        expect(plan.payload.match).toContain('no touch matches');
    });
    it('produces a stable idempotent key so re-polling the window is a no-op', () => {
        const a = planEmailReply(emailReply(), index());
        const b = planEmailReply(emailReply(), index());
        expect(a.eventKey).toBe(b.eventKey);
        const other = planEmailReply(emailReply({ messageId: '<reply-2@gmail.com>' }), index());
        expect(other.eventKey).not.toBe(a.eventKey);
    });
    it('still keys a reply that has no Message-ID at all', () => {
        const plan = planEmailReply(emailReply({ messageId: null }), index());
        expect(plan.eventKey).toMatch(/^imap:reply:[0-9a-f]{32}$/);
    });
});
describe('DM reply matching', () => {
    const dm = (overrides: Partial<HeyReachReply> = {}): HeyReachReply => ({
        providerMessageId: 'hr-123',
        providerThreadId: 'hr-thread-1',
        correlationId: 'li-t902',
        linkedinUrl: 'https://www.linkedin.com/in/alex-example',
        text: 'Early, usually. Happy to compare notes.',
        receivedAt: NOW,
        ...overrides,
    });
    it('matches on the correlation id we stamped on the touch', () => {
        const plan = planDmReply(dm(), index());
        expect(plan.kind).toBe('reply');
        expect(plan.touchId).toBe(902);
        expect(plan.pauseProspectId).toBe(55);
        expect(plan.payload.match).toBe('correlation');
    });
    it('falls back to the profile URL when the correlation id is gone', () => {
        const plan = planDmReply(dm({ correlationId: null }), index());
        expect(plan.touchId).toBe(902);
        expect(plan.payload.match).toBe('linkedin_url');
    });
    it('surfaces an unattributable DM rather than losing it', () => {
        const plan = planDmReply(dm({ correlationId: null, linkedinUrl: 'https://www.linkedin.com/in/nobody' }), index());
        expect(plan.kind).toBe('unmatched_reply');
    });
    it('parses the ref slug format we actually emit', () => {
        expect(touchIdFromRef('li-t902')).toBe(902);
        expect(touchIdFromRef('li-test')).toBeNull();
        expect(touchIdFromRef(null)).toBeNull();
    });
});
describe('outcome export cursor — no row lost across a restart', () => {
    const outcome = (sequence: number, kind: string, ref: string | null): PlatformOutcome => ({
        sequence,
        eventKey: `platform:${sequence}`,
        refSlug: ref,
        email: 'jordan@sample-services.example',
        kind,
        occurredAt: NOW.toISOString(),
    });
    it('processes everything above the cursor and advances to the highest seen', () => {
        const plan = planOutcomeSync([outcome(11, 'sent', 'li-t901'), outcome(12, 'clicked', 'li-t901'), outcome(13, 'claimed', 'li-t901')], index(), 10);
        expect(plan.events).toHaveLength(3);
        expect(plan.newCursor).toBe(13);
    });
    it('ignores rows at or below the cursor — replay is a no-op', () => {
        const plan = planOutcomeSync([outcome(9, 'sent', 'li-t901'), outcome(10, 'clicked', 'li-t901')], index(), 10);
        expect(plan.events).toHaveLength(0);
        expect(plan.newCursor).toBe(10);
    });
    it('loses nothing when a crash truncates the batch — the tail replays', () => {
        const all = [11, 12, 13, 14, 15].map((s) => outcome(s, 'clicked', 'li-t901'));
        const firstHalf = planOutcomeSync(all.slice(0, 2), index(), 10);
        expect(firstHalf.newCursor).toBe(12);
        const afterRestart = planOutcomeSync(all, index(), firstHalf.newCursor);
        expect(afterRestart.events.map((e) => e.eventKey)).toEqual([
            'platform:13',
            'platform:14',
            'platform:15',
        ]);
        expect(afterRestart.newCursor).toBe(15);
        const seen = [...firstHalf.events, ...afterRestart.events].map((e) => e.eventKey);
        expect(new Set(seen).size).toBe(5);
    });
    it('handles out-of-order delivery by sorting on sequence', () => {
        const plan = planOutcomeSync([outcome(13, 'claimed', 'li-t901'), outcome(11, 'sent', 'li-t901'), outcome(12, 'clicked', 'li-t901')], index(), 10);
        expect(plan.events.map((e) => e.eventKey)).toEqual(['platform:11', 'platform:12', 'platform:13']);
    });
    it('counts an unattributable outcome instead of hiding it', () => {
        const plan = planOutcomeSync([{ ...outcome(11, 'claimed', null), email: 'nobody@example.com' }], index(), 10);
        expect(plan.unmatched).toBe(1);
        expect(plan.events).toHaveLength(1);
        expect(plan.newCursor).toBe(11);
    });
    it('never lets an unknown event kind stall the cursor', () => {
        const plan = planOutcomeSync([outcome(11, 'some_new_kind', 'li-t901')], index(), 10);
        expect(plan.newCursor).toBe(11);
        expect(plan.events[0]!.payload.rawKind).toBe('some_new_kind');
    });
});
describe('gmail deep links', () => {
    it('prefers a thread id', () => {
        expect(gmailThreadUrl('https://mail.google.com/mail/u/0/#all', 'abc', '<x@y>')).toBe('https://mail.google.com/mail/u/0/#all/abc');
    });
    it('falls back to an rfc822 message-id search', () => {
        expect(gmailThreadUrl('https://mail.google.com/mail/u/0/#all', null, '<x@y>')).toContain('rfc822msgid');
    });
});
