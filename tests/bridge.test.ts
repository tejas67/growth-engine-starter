import { describe, expect, it, vi } from 'vitest';
import { BridgeClient, BridgeError, bridgeEventsToOutcomes, campaignKeyFor, captureTransport, dedupeByEventKey, failureReasonOf, isTerminal, prospectIdFromRef, prospectRef, readError, readReason, renderDrifted, renderedBytes, routeAfterRejection, routeAfterRequest, validatePush, type BridgeEvent, type BridgeHttpRequest, type BridgeTransport, type PushProspectInput, } from '../src/pipeline/bridge.js';
import { planOutcomeSync, resetUnknownKindWarnings, type SentTouchIndex, } from '../src/pipeline/ingest.js';
const REQUEST_ID = '3f6b1c62-1a1a-4a5f-9d31-1f0b0a2c4d55';
interface ScriptedOptions {
    initialStatus?: string;
    rendered?: {
        subject: string;
        text: string;
        html: string;
        hash: string;
    } | null;
    reRenderOnFirstApprove?: {
        subject: string;
        text: string;
        html: string;
        hash: string;
    } | null;
    matchCount?: number;
    events?: BridgeEvent[];
    rowExtras?: Record<string, unknown>;
    wrongStage?: boolean;
    intakeRejection?: {
        error: string;
        message: string;
    };
}
function scriptedBridge(opts: ScriptedOptions = {}) {
    const byRef = new Map<string, Record<string, unknown>>();
    let rendered = opts.rendered ?? null;
    let approvals = 0;
    let created = 0;
    const transport: BridgeTransport = async (req: BridgeHttpRequest) => {
        if (req.method === 'POST' && req.path === '/prospects') {
            if (opts.intakeRejection) {
                return { status: 422, body: { success: false, ...opts.intakeRejection } };
            }
            const body = req.body as {
                prospect_ref: string;
            };
            const existing = byRef.get(body.prospect_ref);
            if (existing) {
                return { status: 200, body: { request_id: existing.request_id, status: existing.status } };
            }
            created += 1;
            const row = {
                request_id: REQUEST_ID,
                prospect_ref: body.prospect_ref,
                status: opts.initialStatus ?? 'seeded',
                match_count: opts.matchCount ?? null,
            };
            byRef.set(body.prospect_ref, row);
            return { status: 200, body: { request_id: row.request_id, status: row.status } };
        }
        if (req.method === 'GET' && req.path.startsWith('/requests/')) {
            const row = [...byRef.values()][0];
            if (!row)
                return { status: 404, body: { reason: 'no such request' } };
            return {
                status: 200,
                body: {
                    ...row,
                    match_count: opts.matchCount ?? null,
                    headline_total_usd: null,
                    rendered_subject: rendered?.subject ?? null,
                    rendered_body_text: rendered?.text ?? null,
                    rendered_body_html: rendered?.html ?? null,
                    content_hash: rendered?.hash ?? null,
                    ...(opts.rowExtras ?? {}),
                },
            };
        }
        if (req.method === 'POST' && req.path.endsWith('/approve')) {
            approvals += 1;
            const body = req.body as {
                content_hash: string;
            };
            if (opts.wrongStage) {
                return {
                    status: 422,
                    body: { success: false, error: 'wrong_stage', message: 'request is sent, not awaiting_approval' },
                };
            }
            if (approvals === 1 && opts.reRenderOnFirstApprove) {
                rendered = opts.reRenderOnFirstApprove;
                return { status: 409, body: { reason: 'content hash does not match the stored render' } };
            }
            if (!rendered || body.content_hash !== rendered.hash) {
                return { status: 409, body: { reason: 'content hash does not match the stored render' } };
            }
            const row = [...byRef.values()][0]!;
            row.status = 'approved';
            return { status: 200, body: { status: 'approved' } };
        }
        if (req.method === 'POST' && req.path.endsWith('/skip')) {
            if (opts.wrongStage) {
                return {
                    status: 422,
                    body: { success: false, error: 'wrong_stage', message: 'request is sent and can no longer be skipped' },
                };
            }
            const row = [...byRef.values()][0]!;
            row.status = 'skipped';
            return { status: 200, body: { status: 'skipped' } };
        }
        if (req.method === 'GET' && req.path === '/events') {
            const after = Number(req.query?.after ?? 0);
            const limit = Number(req.query?.limit ?? 100);
            const page = (opts.events ?? []).filter((e) => e.seq > after).slice(0, limit);
            return { status: 200, body: page };
        }
        if (req.method === 'GET' && req.path === '/suppression-check') {
            return { status: 200, body: { suppressed: false, reasons: [] } };
        }
        return { status: 404, body: { reason: `unhandled ${req.method} ${req.path}` } };
    };
    return {
        transport,
        approvalCount: () => approvals,
        requestsCreated: () => created,
    };
}
function pushInput(overrides: Partial<PushProspectInput> = {}): PushProspectInput {
    return {
        prospectRef: prospectRef(901),
        campaignKey: campaignKeyFor('li-signal', 'w1'),
        company: { name: 'Sample Services', website: 'https://sample-services.example' },
        contact: {
            email: 'jordan@sample-services.example',
            firstName: 'Jordan',
            lastName: 'Reyes',
            linkedinUrl: 'https://www.linkedin.com/in/alex-sample',
        },
        icpScore: 82,
        persona: 'P1',
        ...overrides,
    };
}
describe('pushing a prospect is idempotent on prospect_ref', () => {
    it('returns the SAME request twice and never creates a second one', async () => {
        const bridge = scriptedBridge();
        const transport = captureTransport(bridge.transport);
        const client = BridgeClient.withTransport(transport);
        const first = await client.pushProspect(pushInput());
        const second = await client.pushProspect(pushInput());
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok)
            return;
        expect(second.requestId).toBe(first.requestId);
        expect(transport.calls.filter((c) => c.request.path === '/prospects')).toHaveLength(2);
        expect(bridge.requestsCreated()).toBe(1);
        const refs = transport.calls.map((c) => (c.request.body as {
            prospect_ref: string;
        }).prospect_ref);
        expect(new Set(refs)).toEqual(new Set(['li-p901']));
    });
    it('round-trips the prospect ref', () => {
        expect(prospectIdFromRef(prospectRef(42))).toBe(42);
        expect(prospectIdFromRef('li-t42')).toBeNull();
        expect(prospectIdFromRef(null)).toBeNull();
    });
});
describe('approval: a 409 means re-fetch and re-approve, never a re-render on our side', () => {
    const stale = { subject: 'Up to $2.4M matched to Sample Services', text: 'stale body', html: '<p>stale</p>', hash: 'hash-stale' };
    const fresh = { subject: 'Up to $1.1M matched to Sample Services', text: 'fresh body', html: '<p>fresh</p>', hash: 'hash-fresh' };
    it('rejects the stale hash, then accepts the re-fetched one', async () => {
        const bridge = scriptedBridge({
            initialStatus: 'awaiting_approval',
            rendered: stale,
            reRenderOnFirstApprove: fresh,
            matchCount: 4,
        });
        const client = BridgeClient.withTransport(captureTransport(bridge.transport));
        await client.pushProspect(pushInput());
        const shown = await client.getRequest(REQUEST_ID);
        expect(shown.ok).toBe(true);
        if (!shown.ok)
            return;
        expect(renderedBytes(shown.row)?.text).toBe('stale body');
        const firstAttempt = await client.approve(REQUEST_ID, stale.hash, 'owner');
        expect(firstAttempt.ok).toBe(false);
        if (firstAttempt.ok)
            return;
        expect(firstAttempt.kind).toBe('hash_mismatch');
        const refetched = await client.getRequest(REQUEST_ID);
        expect(refetched.ok).toBe(true);
        if (!refetched.ok)
            return;
        const bytes = renderedBytes(refetched.row);
        expect(bytes?.text).toBe('fresh body');
        expect(refetched.row.content_hash).toBe(fresh.hash);
        const secondAttempt = await client.approve(REQUEST_ID, refetched.row.content_hash!, 'owner');
        expect(secondAttempt.ok).toBe(true);
    });
    it('a mismatched hash on a request that never moved is still refused', async () => {
        const bridge = scriptedBridge({ initialStatus: 'awaiting_approval', rendered: stale });
        const client = BridgeClient.withTransport(bridge.transport);
        await client.pushProspect(pushInput());
        const result = await client.approve(REQUEST_ID, 'hash-of-something-else', 'owner');
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.kind).toBe('hash_mismatch');
    });
});
describe('event feed: cursor resume and event_key idempotency', () => {
    const event = (seq: number, kind: string, key = `bridge:${seq}`): BridgeEvent => ({
        seq,
        event_key: key,
        request_id: REQUEST_ID,
        prospect_ref: 'li-p901',
        kind,
        occurred_at: '2026-08-27T12:00:00.000Z',
        payload: {},
    });
    const index = (): SentTouchIndex => ({
        byMessageId: new Map(),
        byRecipient: new Map(),
        byLinkedInUrl: new Map(),
        prospectOf: new Map([[55, 901]]),
    });
    const resolve = () => ({ touchId: 55, prospectId: 901 });
    it('reads forward from the cursor and loses nothing across a restart', async () => {
        const all = [11, 12, 13, 14, 15].map((s) => event(s, 'clicked'));
        const bridge = scriptedBridge({ events: all });
        const client = BridgeClient.withTransport(bridge.transport);
        const firstPage = await client.fetchEvents(10, 2);
        const firstPlan = planOutcomeSync(bridgeEventsToOutcomes(firstPage.events, resolve), index(), 10);
        expect(firstPlan.newCursor).toBe(12);
        const secondPage = await client.fetchEvents(firstPlan.newCursor, 100);
        const secondPlan = planOutcomeSync(bridgeEventsToOutcomes(secondPage.events, resolve), index(), firstPlan.newCursor);
        const applied = [...firstPlan.events, ...secondPlan.events].map((e) => e.eventKey);
        expect(applied).toEqual(['bridge:11', 'bridge:12', 'bridge:13', 'bridge:14', 'bridge:15']);
        expect(new Set(applied).size).toBe(5);
        expect(secondPlan.newCursor).toBe(15);
    });
    it('re-delivering the same event_key is a no-op, not a second metric', () => {
        const duplicated = [event(11, 'clicked'), event(11, 'clicked'), event(12, 'claimed')];
        expect(dedupeByEventKey(duplicated)).toHaveLength(2);
        const plan = planOutcomeSync(bridgeEventsToOutcomes(duplicated, resolve), index(), 12);
        expect(plan.events).toHaveLength(0);
        expect(plan.newCursor).toBe(12);
    });
    it('attributes a lifecycle event that arrives before any touch exists', () => {
        const seeded = event(3, 'seeded');
        const outcomes = bridgeEventsToOutcomes([seeded], () => ({ touchId: null, prospectId: 901 }));
        const plan = planOutcomeSync(outcomes, index(), 0);
        expect(plan.events[0]!.kind).toBe('seeded');
        expect(plan.events[0]!.prospectId).toBe(901);
        expect(plan.unmatched).toBe(0);
    });
    it('records an unrecognised kind as unknown rather than as a send', () => {
        const outcomes = bridgeEventsToOutcomes([event(4, 'teleported')], resolve);
        const plan = planOutcomeSync(outcomes, index(), 0);
        expect(plan.events[0]!.kind).toBe('unknown_outcome');
        expect(plan.events[0]!.payload.rawKind).toBe('teleported');
        expect(plan.newCursor).toBe(4);
    });
});
describe('no proof means the DM lane, never a padded number', () => {
    it('routes DM-only on an explicit no_proof verdict', () => {
        const routing = routeAfterRequest({ status: 'no_proof', match_count: null });
        expect(routing.lane).toBe('dm_only');
        expect(routing.noProof).toBe(true);
    });
    it('routes DM-only when a match run completes with zero matches', () => {
        const routing = routeAfterRequest({ status: 'match_ready', match_count: 0 });
        expect(routing.lane).toBe('dm_only');
        expect(routing.noProof).toBe(true);
    });
    it('keeps the email lane when there is at least one real match', () => {
        const routing = routeAfterRequest({ status: 'awaiting_approval', match_count: 1 });
        expect(routing.lane).toBe('email');
        expect(routing.noProof).toBe(false);
    });
    it('refuses to push a prospect the email lane cannot serve, and says which lane they land in', () => {
        const noWebsite = validatePush(pushInput({ company: { name: 'Sample Services', website: null } }));
        expect(noWebsite.ok).toBe(false);
        if (noWebsite.ok)
            return;
        expect(noWebsite.route).toBe('dm_only');
        const noMailbox = validatePush(pushInput({ contact: { email: null, firstName: 'J', lastName: null, linkedinUrl: null } }));
        expect(noMailbox.ok).toBe(false);
        const gov = validatePush(pushInput({
            contact: {
                email: 'someone@navy.mil',
                firstName: 'Sam',
                lastName: null,
                linkedinUrl: null,
            },
        }));
        expect(gov.ok).toBe(false);
        if (gov.ok)
            return;
        expect(gov.reason).toContain('gov gate');
        expect(gov.route).toBe('dm_only');
    });
    it('knows which states are finished', () => {
        expect(isTerminal('sent')).toBe(true);
        expect(isTerminal('no_proof')).toBe(true);
        expect(isTerminal('awaiting_approval')).toBe(false);
    });
});
describe('`failed` is a terminal platform failure, and never a verdict about a company', () => {
    it('routes DM-only, is terminal, and carries stage_reason as the explanation', async () => {
        const bridge = scriptedBridge({
            initialStatus: 'failed',
            rowExtras: { stage_reason: 'seed: the program slug hand_raise_2026_08 does not exist' },
        });
        const client = BridgeClient.withTransport(bridge.transport);
        await client.pushProspect(pushInput());
        const fetched = await client.getRequest(REQUEST_ID);
        expect(fetched.ok).toBe(true);
        if (!fetched.ok)
            return;
        expect(isTerminal('failed')).toBe(true);
        const routing = routeAfterRequest(fetched.row);
        expect(routing.lane).toBe('dm_only');
        expect(routing.failed).toBe(true);
        expect(routing.noProof).toBe(false);
        expect(routing.reason).toContain('hand_raise_2026_08');
    });
    it('does NOT become no_proof just because a failed run left match_count at zero', () => {
        const routing = routeAfterRequest({
            status: 'failed',
            match_count: 0,
            stage_reason: 'match: the opportunity search never completed',
        });
        expect(routing.failed).toBe(true);
        expect(routing.noProof).toBe(false);
    });
    it('prefers stage_reason, falls back to failure_reason, and stays legible with neither', () => {
        expect(failureReasonOf({ stage_reason: 'enqueue: no search slot', failure_reason: 'older text' }))
            .toBe('enqueue: no search slot');
        expect(failureReasonOf({ stage_reason: null, failure_reason: 'older text' })).toBe('older text');
        expect(failureReasonOf({ stage_reason: '  ', failure_reason: null })).toBeNull();
        expect(routeAfterRequest({ status: 'failed', match_count: null }).reason).toBe('the platform could not complete this run');
    });
});
describe('a wrong-stage refusal is 422, and must not turn into a re-approval loop', () => {
    it('maps 422 wrong_stage to wrong_state, NOT to hash_mismatch', async () => {
        const bridge = scriptedBridge({ initialStatus: 'sent', wrongStage: true });
        const transport = captureTransport(bridge.transport);
        const client = BridgeClient.withTransport(transport);
        await client.pushProspect(pushInput());
        const result = await client.approve(REQUEST_ID, 'hash-the-founder-approved', 'owner');
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.kind).toBe('wrong_state');
        if (result.kind !== 'wrong_state')
            return;
        expect(result.status).toBe(422);
        expect(result.code).toBe('wrong_stage');
        expect(result.reason).toContain('wrong_stage');
        expect(result.reason).toContain('not awaiting_approval');
    });
    it('re-approving a wrong-stage request is futile, which is why the caller re-reads instead', async () => {
        const bridge = scriptedBridge({ initialStatus: 'sent', wrongStage: true });
        const client = BridgeClient.withTransport(bridge.transport);
        await client.pushProspect(pushInput());
        for (let attempt = 0; attempt < 3; attempt++) {
            const result = await client.approve(REQUEST_ID, 'any-hash-at-all', 'owner');
            expect(result.ok).toBe(false);
        }
        expect(bridge.approvalCount()).toBe(3);
    });
    it('keeps 409 meaning hash mismatch and nothing else', async () => {
        const rendered = { subject: 's', text: 't', html: '<p>t</p>', hash: 'hash-current' };
        const bridge = scriptedBridge({ initialStatus: 'awaiting_approval', rendered });
        const client = BridgeClient.withTransport(bridge.transport);
        await client.pushProspect(pushInput());
        const result = await client.approve(REQUEST_ID, 'hash-stale', 'owner');
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.kind).toBe('hash_mismatch');
    });
    it('reports a wrong-stage skip rather than retrying it forever', async () => {
        const bridge = scriptedBridge({ initialStatus: 'sent', wrongStage: true });
        const client = BridgeClient.withTransport(bridge.transport);
        await client.pushProspect(pushInput());
        const result = await client.skip(REQUEST_ID, 'declined in the dashboard');
        expect(result.ok).toBe(false);
        expect(result.status).toBe(422);
        expect(result.code).toBe('wrong_stage');
    });
    it('sends the decline REASON with a skip, so a "no" can be read back later', async () => {
        const bridge = scriptedBridge({ initialStatus: 'awaiting_approval' });
        const transport = captureTransport(bridge.transport);
        const client = BridgeClient.withTransport(transport);
        await client.pushProspect(pushInput());
        const result = await client.skip(REQUEST_ID, 'wrong person at this company');
        expect(result.ok).toBe(true);
        expect(result.code).toBeNull();
        const skipCall = transport.calls.find((c) => c.request.path.endsWith('/skip'));
        expect(skipCall?.request.body).toEqual({ reason: 'wrong person at this company' });
    });
});
describe('a 422 intake rejection carries a code, and DM-only routing keys on the code', () => {
    it('surfaces both the error code and the message', async () => {
        const bridge = scriptedBridge({
            intakeRejection: { error: 'gov_mailbox', message: 'contact.email is a government mailbox' },
        });
        const client = BridgeClient.withTransport(bridge.transport);
        const result = await client.pushProspect(pushInput());
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.status).toBe(422);
        expect(result.code).toBe('gov_mailbox');
        expect(result.reason).toContain('gov_mailbox');
        expect(result.reason).toContain('government mailbox');
    });
    it('routes every known intake code DM-only, keyed on the code and not on the prose', () => {
        for (const code of ['gov_mailbox', 'missing_website', 'missing_email']) {
            const rejection = routeAfterRejection(code, 'some wording the platform may change tomorrow');
            expect(rejection.route).toBe('dm_only');
            expect(rejection.known).toBe(true);
            expect(rejection.code).toBe(code);
            expect(rejection.reason).not.toContain('tomorrow');
        }
    });
    it('still routes an unknown code, and says out loud that it is unknown', () => {
        const rejection = routeAfterRejection('mailbox_on_fire', 'the mailbox is on fire');
        expect(rejection.route).toBe('dm_only');
        expect(rejection.known).toBe(false);
        expect(rejection.reason).toContain('mailbox_on_fire');
        expect(rejection.reason).toContain('on fire');
    });
    it('splits a refusal body into its machine half and its human half', () => {
        expect(readError({ success: false, error: 'missing_website', message: 'company.website is required' }))
            .toEqual({ code: 'missing_website', message: 'company.website is required' });
        expect(readReason({ success: false, error: 'missing_website', message: 'company.website is required' }))
            .toBe('missing_website: company.website is required');
        expect(readError({ error: 'we could not accept this prospect' }))
            .toEqual({ code: null, message: 'we could not accept this prospect' });
        expect(readReason({ reason: 'contact.email is a government mailbox' }))
            .toBe('contact.email is a government mailbox');
        expect(readReason(null)).toBeNull();
    });
});
describe('a re-render voids the approval and puts the row back in the Approve view', () => {
    it('detects drift from the hash, which arrives on every poll', () => {
        const drifted = renderDrifted('hash-approved', {
            status: 'awaiting_approval',
            content_hash: 'hash-rerendered',
        });
        expect(drifted).toBe(true);
    });
    it('is not drift when the hash is unchanged, or when the render is merely arriving', () => {
        expect(renderDrifted('hash-a', { status: 'awaiting_approval', content_hash: 'hash-a' })).toBe(false);
        expect(renderDrifted(null, { status: 'awaiting_approval', content_hash: 'hash-a' })).toBe(false);
        expect(renderDrifted('hash-a', { status: 'sending', content_hash: 'hash-b' })).toBe(false);
        expect(renderDrifted('hash-a', { status: 'awaiting_approval', content_hash: null })).toBe(false);
    });
    it('records the rerender event as itself, so the audit trail shows the second ask', () => {
        const rerender: BridgeEvent = {
            seq: 20,
            event_key: 'bridge:20',
            request_id: REQUEST_ID,
            prospect_ref: 'li-p901',
            kind: 'rerender',
            occurred_at: '2026-08-27T12:00:00.000Z',
            payload: { stage_reason: 'two of the four matched opportunities closed' },
        };
        const plan = planOutcomeSync(bridgeEventsToOutcomes([rerender], () => ({ touchId: 55, prospectId: 901 })), {
            byMessageId: new Map(),
            byRecipient: new Map(),
            byLinkedInUrl: new Map(),
            prospectOf: new Map([[55, 901]]),
        }, 0);
        expect(plan.events[0]!.kind).toBe('rerender');
        expect(plan.events[0]!.touchId).toBe(55);
    });
});
describe('the event vocabulary, and what happens to a word we do not know', () => {
    const index = (): SentTouchIndex => ({
        byMessageId: new Map(),
        byRecipient: new Map(),
        byLinkedInUrl: new Map(),
        prospectOf: new Map([[55, 901]]),
    });
    const event = (seq: number, kind: string): BridgeEvent => ({
        seq,
        event_key: `bridge:${kind}:${seq}`,
        request_id: REQUEST_ID,
        prospect_ref: 'li-p901',
        kind,
        occurred_at: '2026-08-27T12:00:00.000Z',
        payload: {},
    });
    it('records failed, no_proof and rerender as themselves', () => {
        const kinds = ['failed', 'no_proof', 'rerender'];
        const outcomes = bridgeEventsToOutcomes(kinds.map((kind, i) => event(30 + i, kind)), () => ({ touchId: 55, prospectId: 901 }));
        const plan = planOutcomeSync(outcomes, index(), 0);
        expect(plan.events.map((e) => e.kind)).toEqual(kinds);
        expect(plan.events.some((e) => e.kind === 'unknown_outcome')).toBe(false);
    });
    it('degrades an unknown kind to unknown_outcome but complains only ONCE per kind', () => {
        resetUnknownKindWarnings();
        const warnings = vi.spyOn(console, 'error').mockImplementation(() => { });
        const outcomes = bridgeEventsToOutcomes([event(40, 'teleported'), event(41, 'teleported'), event(42, 'teleported')], () => ({ touchId: 55, prospectId: 901 }));
        const plan = planOutcomeSync(outcomes, index(), 0);
        expect(plan.events).toHaveLength(3);
        expect(plan.events.every((e) => e.kind === 'unknown_outcome')).toBe(true);
        expect(plan.events[0]!.payload.rawKind).toBe('teleported');
        const teleportWarnings = warnings.mock.calls.filter((c) => String(c[0]).includes('teleported'));
        expect(teleportWarnings).toHaveLength(1);
        planOutcomeSync(bridgeEventsToOutcomes([event(43, 'defenestrated')], () => ({ touchId: 55, prospectId: 901 })), index(), 42);
        expect(warnings.mock.calls.filter((c) => String(c[0]).includes('defenestrated'))).toHaveLength(1);
        warnings.mockRestore();
        resetUnknownKindWarnings();
    });
});
describe('the event feed may lag ~30s behind the writes it describes', () => {
    it('treats an empty page as a quiet feed, not an error and not a stall', async () => {
        const bridge = scriptedBridge({ events: [] });
        const client = BridgeClient.withTransport(bridge.transport);
        const page = await client.fetchEvents(17, 100);
        expect(page.events).toEqual([]);
        expect(page.highestSeq).toBe(17);
        const plan = planOutcomeSync(bridgeEventsToOutcomes(page.events, () => ({ touchId: null, prospectId: null })), {
            byMessageId: new Map(),
            byRecipient: new Map(),
            byLinkedInUrl: new Map(),
            prospectOf: new Map(),
        }, 17);
        expect(plan.events).toHaveLength(0);
        expect(plan.newCursor).toBe(17);
        expect(plan.unmatched).toBe(0);
    });
    it('picks the late event up on the next poll, from the unmoved cursor', async () => {
        const late: BridgeEvent = {
            seq: 18,
            event_key: 'bridge:18',
            request_id: REQUEST_ID,
            prospect_ref: 'li-p901',
            kind: 'sent',
            occurred_at: '2026-08-27T12:00:00.000Z',
            payload: {},
        };
        const bridge = scriptedBridge({ events: [late] });
        const client = BridgeClient.withTransport(bridge.transport);
        const page = await client.fetchEvents(17, 100);
        expect(page.events.map((e) => e.seq)).toEqual([18]);
        expect(page.highestSeq).toBe(18);
    });
});
describe('failure handling', () => {
    it('an unconfigured bridge is unavailable, not an exception waiting to happen', () => {
        const client = new BridgeClient(null, false, 'GROWTH_BRIDGE_ENABLED is false');
        expect(client.available).toBe(false);
        expect(client.unavailableReason).toContain('GROWTH_BRIDGE_ENABLED');
    });
    it('calling an unavailable bridge throws a typed error rather than a TypeError', async () => {
        const client = new BridgeClient(null, false, 'not configured');
        await expect(client.pushProspect(pushInput())).rejects.toBeInstanceOf(BridgeError);
    });
    it('treats a response that does not match the contract as drift, not as data', async () => {
        const transport: BridgeTransport = async () => ({ status: 200, body: { request_id: 'not-a-uuid' } });
        const client = BridgeClient.withTransport(transport);
        await expect(client.pushProspect(pushInput())).rejects.toMatchObject({ kind: 'schema_drift' });
    });
    it('reports a rejected push instead of throwing, so the prospect can be re-routed', async () => {
        const transport: BridgeTransport = async () => ({
            status: 422,
            body: { reason: 'contact.email is a government mailbox' },
        });
        const client = BridgeClient.withTransport(transport);
        const result = await client.pushProspect(pushInput());
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.reason).toContain('government mailbox');
    });
    it('turns a server error into a typed failure the caller can hold on', async () => {
        const transport: BridgeTransport = async () => ({ status: 503, body: { reason: 'deploying' } });
        const client = BridgeClient.withTransport(transport);
        await expect(client.getRequest(REQUEST_ID)).rejects.toMatchObject({ kind: 'server' });
    });
});
