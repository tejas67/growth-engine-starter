import type { DetectedReply, ImapReader } from '../clients/imap.js';
import type { HeyReachClient, HeyReachReply } from '../clients/heyreach.js';
import { normalizeEmail } from '../lib/identity.js';
import { sha256 } from '../lib/hash.js';
import { logger } from '../lib/log.js';
const log = logger('ingest');
export interface SentTouchIndex {
    byMessageId: Map<string, number>;
    byRecipient: Map<string, number[]>;
    byLinkedInUrl: Map<string, number[]>;
    prospectOf: Map<number, number>;
}
export type ReplyMatch = {
    matched: true;
    touchId: number;
    prospectId: number;
    via: 'correlation' | 'message_id' | 'recipient' | 'linkedin_url';
} | {
    matched: false;
    reason: string;
};
export function touchIdFromRef(ref: string | null | undefined): number | null {
    if (!ref)
        return null;
    const m = /^li-t(\d+)$/.exec(ref.trim());
    return m?.[1] ? Number(m[1]) : null;
}
export function matchEmailReply(reply: DetectedReply, index: SentTouchIndex): ReplyMatch {
    const chain = [reply.inReplyTo, ...reply.references].filter((r): r is string => Boolean(r));
    for (const id of chain) {
        const touchId = index.byMessageId.get(id.trim());
        if (touchId !== undefined) {
            const prospectId = index.prospectOf.get(touchId);
            if (prospectId !== undefined)
                return { matched: true, touchId, prospectId, via: 'message_id' };
        }
    }
    const from = normalizeEmail(reply.from);
    if (from) {
        const touches = index.byRecipient.get(from);
        const touchId = touches?.[0];
        if (touchId !== undefined) {
            const prospectId = index.prospectOf.get(touchId);
            if (prospectId !== undefined)
                return { matched: true, touchId, prospectId, via: 'recipient' };
        }
    }
    return { matched: false, reason: `no touch matches message ${reply.messageId ?? '(no id)'} from ${reply.from ?? '(unknown)'}` };
}
export function matchDmReply(reply: HeyReachReply, index: SentTouchIndex): ReplyMatch {
    const fromCorrelation = touchIdFromRef(reply.correlationId);
    if (fromCorrelation !== null) {
        const prospectId = index.prospectOf.get(fromCorrelation);
        if (prospectId !== undefined) {
            return { matched: true, touchId: fromCorrelation, prospectId, via: 'correlation' };
        }
    }
    if (reply.linkedinUrl) {
        const touches = index.byLinkedInUrl.get(reply.linkedinUrl.toLowerCase());
        const touchId = touches?.[0];
        if (touchId !== undefined) {
            const prospectId = index.prospectOf.get(touchId);
            if (prospectId !== undefined)
                return { matched: true, touchId, prospectId, via: 'linkedin_url' };
        }
    }
    return { matched: false, reason: `no touch matches DM ${reply.providerMessageId}` };
}
export interface ReplyEventPlan {
    eventKey: string;
    touchId: number | null;
    prospectId: number | null;
    kind: 'reply' | 'unmatched_reply';
    channel: 'email' | 'dm';
    source: 'imap' | 'heyreach';
    payload: Record<string, unknown>;
    occurredAt: Date;
    pauseProspectId: number | null;
}
export function replyEventKey(source: string, identity: string): string {
    return `${source}:reply:${sha256(identity).slice(0, 32)}`;
}
export function planEmailReply(reply: DetectedReply, index: SentTouchIndex): ReplyEventPlan {
    const match = matchEmailReply(reply, index);
    const identity = reply.messageId ?? `${reply.from ?? ''}|${reply.subject ?? ''}|${reply.receivedAt.toISOString()}`;
    const base = {
        eventKey: replyEventKey('imap', identity),
        channel: 'email' as const,
        source: 'imap' as const,
        occurredAt: reply.receivedAt,
        payload: {
            from: reply.from,
            subject: reply.subject,
            excerpt: reply.text.slice(0, 500),
            messageId: reply.messageId,
            gmailThreadId: reply.gmailThreadId,
            match: match.matched ? match.via : match.reason,
        },
    };
    if (match.matched) {
        return { ...base, kind: 'reply', touchId: match.touchId, prospectId: match.prospectId, pauseProspectId: match.prospectId };
    }
    return { ...base, kind: 'unmatched_reply', touchId: null, prospectId: null, pauseProspectId: null };
}
export function planDmReply(reply: HeyReachReply, index: SentTouchIndex): ReplyEventPlan {
    const match = matchDmReply(reply, index);
    const base = {
        eventKey: replyEventKey('heyreach', reply.providerMessageId),
        channel: 'dm' as const,
        source: 'heyreach' as const,
        occurredAt: reply.receivedAt,
        payload: {
            linkedinUrl: reply.linkedinUrl,
            excerpt: reply.text.slice(0, 500),
            providerMessageId: reply.providerMessageId,
            match: match.matched ? match.via : match.reason,
        },
    };
    if (match.matched) {
        return { ...base, kind: 'reply', touchId: match.touchId, prospectId: match.prospectId, pauseProspectId: match.prospectId };
    }
    return { ...base, kind: 'unmatched_reply', touchId: null, prospectId: null, pauseProspectId: null };
}
export interface PlatformOutcome {
    sequence: number;
    eventKey: string;
    refSlug: string | null;
    email: string | null;
    prospectId?: number | null;
    kind: string;
    occurredAt: string;
    payload?: Record<string, unknown>;
}
export interface OutcomeSyncPlan {
    events: Array<{
        eventKey: string;
        touchId: number | null;
        prospectId: number | null;
        kind: string;
        channel: 'email';
        source: 'platform_export';
        payload: Record<string, unknown>;
        occurredAt: Date;
    }>;
    newCursor: number;
    unmatched: number;
}
const VALID_OUTCOMES = new Set([
    'sent',
    'delivered',
    'clicked',
    'claimed',
    'signed_in',
    'activated',
    'bounced',
    'hard_bounced',
    'unsubscribed',
    'seeded',
    'match_ready',
    'awaiting_approval',
    'approved',
    'send_failed',
    'suppressed',
    'skipped',
    'revalidation_failed',
    'no_proof',
    'failed',
    'rerender',
]);
const UNKNOWN_OUTCOME = 'unknown_outcome';
const warnedUnknownKinds = new Set<string>();
export function resetUnknownKindWarnings(): void {
    warnedUnknownKinds.clear();
}
function warnUnknownKindOnce(kind: string, sequence: number): void {
    if (warnedUnknownKinds.has(kind))
        return;
    warnedUnknownKinds.add(kind);
    log.warn('unknown outcome kind — recorded as payload, cursor still advances (logged once per kind)', {
        kind,
        sequence,
    });
}
export function planOutcomeSync(outcomes: PlatformOutcome[], index: SentTouchIndex, currentCursor: number): OutcomeSyncPlan {
    const events: OutcomeSyncPlan['events'] = [];
    let newCursor = currentCursor;
    let unmatched = 0;
    for (const outcome of [...outcomes].sort((a, b) => a.sequence - b.sequence)) {
        if (outcome.sequence <= currentCursor)
            continue;
        if (!VALID_OUTCOMES.has(outcome.kind))
            warnUnknownKindOnce(outcome.kind, outcome.sequence);
        const touchId = touchIdFromRef(outcome.refSlug);
        let prospectId = outcome.prospectId ?? (touchId !== null ? (index.prospectOf.get(touchId) ?? null) : null);
        if (prospectId === null && outcome.email) {
            const byEmail = index.byRecipient.get(normalizeEmail(outcome.email) ?? '');
            const fallbackTouch = byEmail?.[0];
            if (fallbackTouch !== undefined)
                prospectId = index.prospectOf.get(fallbackTouch) ?? null;
        }
        if (prospectId === null)
            unmatched += 1;
        events.push({
            eventKey: outcome.eventKey,
            touchId: touchId !== null && index.prospectOf.has(touchId) ? touchId : null,
            prospectId,
            kind: VALID_OUTCOMES.has(outcome.kind) ? outcome.kind : UNKNOWN_OUTCOME,
            channel: 'email',
            source: 'platform_export',
            payload: { ...(outcome.payload ?? {}), rawKind: outcome.kind, refSlug: outcome.refSlug },
            occurredAt: new Date(outcome.occurredAt),
        });
        newCursor = Math.max(newCursor, outcome.sequence);
    }
    return { events, newCursor, unmatched };
}
export async function collectEmailReplies(reader: ImapReader, since: Date, index: SentTouchIndex): Promise<ReplyEventPlan[]> {
    const replies = await reader.fetchSince(since);
    return replies.map((r) => planEmailReply(r, index));
}
export async function collectDmReplies(heyreach: HeyReachClient, since: Date, index: SentTouchIndex): Promise<ReplyEventPlan[]> {
    const replies = await heyreach.fetchReplies(since);
    return replies.map((r) => planDmReply(r, index));
}
export function gmailThreadUrl(base: string, threadId: string | null, messageId: string | null): string {
    if (threadId)
        return `${base}/${threadId}`;
    if (messageId)
        return `${base}/${encodeURIComponent(`rfc822msgid:${messageId}`)}`;
    return base;
}
