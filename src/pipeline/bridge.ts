import { z } from 'zod';
import { config } from '../../config/index.js';
import { coldEmailAllowed } from '../guardrails/gov_gate.js';
import { normalizeEmail } from '../lib/identity.js';
import { logger } from '../lib/log.js';
import type { PlatformOutcome } from './ingest.js';
const log = logger('bridge');
const ROUTE_PREFIX = '/api/growth-bridge';
export interface BridgeHttpRequest {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number>;
    body?: unknown;
}
export interface BridgeHttpResponse {
    status: number;
    body: unknown;
}
export type BridgeTransport = (req: BridgeHttpRequest) => Promise<BridgeHttpResponse>;
export class BridgeError extends Error {
    constructor(message: string, readonly kind: 'transport' | 'auth' | 'server' | 'schema_drift' | 'unavailable', readonly detail?: unknown) {
        super(message);
        this.name = 'BridgeError';
    }
}
export function httpTransport(opts: {
    baseUrl: string;
    serviceKey: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): BridgeTransport {
    const doFetch = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? config.bridge.timeoutMs;
    return async (req) => {
        const url = new URL(`${opts.baseUrl.replace(/\/+$/, '')}${ROUTE_PREFIX}${req.path}`);
        for (const [key, value] of Object.entries(req.query ?? {})) {
            url.searchParams.set(key, String(value));
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await doFetch(url.toString(), {
                method: req.method,
                headers: {
                    'X-Growth-Bridge-Key': opts.serviceKey,
                    ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
                signal: controller.signal,
            });
            const text = await res.text();
            let body: unknown = null;
            if (text) {
                try {
                    body = JSON.parse(text);
                }
                catch {
                    throw new BridgeError(`bridge returned non-JSON on ${req.method} ${req.path} (${res.status})`, 'schema_drift', text.slice(0, 300));
                }
            }
            log.debug('bridge call', { method: req.method, path: req.path, status: res.status });
            return { status: res.status, body };
        }
        catch (err) {
            if (err instanceof BridgeError)
                throw err;
            const message = (err as Error).name === 'AbortError'
                ? `bridge timed out after ${timeoutMs}ms on ${req.method} ${req.path}`
                : `bridge transport failed on ${req.method} ${req.path}: ${(err as Error).message}`;
            throw new BridgeError(message, 'transport');
        }
        finally {
            clearTimeout(timer);
        }
    };
}
export interface CapturedCall {
    request: BridgeHttpRequest;
    response: BridgeHttpResponse;
}
export function captureTransport(inner: BridgeTransport): BridgeTransport & {
    calls: CapturedCall[];
} {
    const calls: CapturedCall[] = [];
    const wrapped = (async (req: BridgeHttpRequest) => {
        const response = await inner(req);
        calls.push({ request: req, response });
        return response;
    }) as BridgeTransport & {
        calls: CapturedCall[];
    };
    wrapped.calls = calls;
    return wrapped;
}
export const BRIDGE_STATUSES = [
    'pending_seed',
    'seeded',
    'awaiting_match',
    'match_ready',
    'awaiting_approval',
    'approved',
    'sending',
    'sent',
    'send_failed',
    'suppressed',
    'skipped',
    'revalidation_failed',
    'no_proof',
    'failed',
] as const;
export type BridgeStatus = (typeof BRIDGE_STATUSES)[number];
const StatusSchema = z.enum(BRIDGE_STATUSES);
const Money = z.union([z.number(), z.string()]).nullish();
const PushResponseSchema = z
    .object({
    request_id: z.string().uuid(),
    status: StatusSchema,
})
    .passthrough();
export const RequestRowSchema = z
    .object({
    request_id: z.string().uuid(),
    prospect_ref: z.string(),
    status: StatusSchema,
    campaign_key: z.string().nullish(),
    match_count: z.number().int().nullish(),
    headline_total_usd: Money,
    top_matches: z.unknown().nullish(),
    rendered_subject: z.string().nullish(),
    rendered_body_html: z.string().nullish(),
    rendered_body_text: z.string().nullish(),
    content_hash: z.string().nullish(),
    failure_reason: z.string().nullish(),
    stage_reason: z.string().nullish(),
    sent_at: z.string().nullish(),
    approved_at: z.string().nullish(),
})
    .passthrough();
export type RequestRow = z.infer<typeof RequestRowSchema>;
const EventSchema = z
    .object({
    seq: z.number().int(),
    event_key: z.string().min(1),
    request_id: z.string().nullish(),
    prospect_ref: z.string().nullish(),
    kind: z.string().min(1),
    occurred_at: z.string(),
    payload: z.unknown().nullish(),
})
    .passthrough();
export type BridgeEvent = z.infer<typeof EventSchema>;
const EventsResponseSchema = z.union([
    z.array(EventSchema),
    z.object({ events: z.array(EventSchema) }).passthrough(),
]);
const SuppressionSchema = z
    .object({
    suppressed: z.boolean(),
    reasons: z.array(z.string()).optional(),
})
    .passthrough();
export function prospectRef(canonicalProspectId: number): string {
    return `li-p${canonicalProspectId}`;
}
export function prospectIdFromRef(ref: string | null | undefined): number | null {
    if (!ref)
        return null;
    const m = /^li-p(\d+)$/.exec(ref.trim());
    return m?.[1] ? Number(m[1]) : null;
}
export function campaignKeyFor(prefix = config.bridge.campaignKeyPrefix, wave = config.bridge.wave): string {
    return `${prefix}-${wave}`;
}
export const TERMINAL_STATUSES: BridgeStatus[] = [
    'sent',
    'send_failed',
    'suppressed',
    'skipped',
    'revalidation_failed',
    'no_proof',
    'failed',
];
export function isTerminal(status: BridgeStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
}
export interface PushProspectInput {
    prospectRef: string;
    campaignKey: string;
    company: {
        name: string | null;
        website: string | null;
    };
    contact: {
        email: string | null;
        firstName: string | null;
        lastName: string | null;
        linkedinUrl: string | null;
    };
    icpScore: number | null;
    persona: string | null;
}
export type PushRefusal = {
    ok: false;
    reason: string;
    route: 'dm_only' | 'hold';
};
export function validatePush(input: PushProspectInput): {
    ok: true;
} | PushRefusal {
    const email = normalizeEmail(input.contact.email);
    if (!email) {
        return { ok: false, reason: 'no mailbox — the email lane needs one', route: 'dm_only' };
    }
    const gov = coldEmailAllowed({
        email,
        employer: input.company.name,
        persona: input.persona,
    });
    if (!gov.allowed) {
        return { ok: false, reason: gov.reason, route: 'dm_only' };
    }
    if (!input.company.website) {
        return {
            ok: false,
            reason: 'no company website — the platform cannot resolve a company to match against',
            route: 'dm_only',
        };
    }
    if (!input.company.name) {
        return { ok: false, reason: 'no company name', route: 'dm_only' };
    }
    return { ok: true };
}
export const INTAKE_REJECTION_CODES: Record<string, string> = {
    gov_mailbox: 'a government mailbox — the cold email lane does not serve .gov/.mil',
    missing_email: 'no mailbox on file, so there is nothing to email',
    missing_website: 'no company website, so the platform cannot resolve a company to match against',
};
export interface IntakeRejection {
    route: 'dm_only';
    code: string | null;
    known: boolean;
    reason: string;
}
export function routeAfterRejection(code: string | null, message?: string | null): IntakeRejection {
    const trimmed = code?.trim() || null;
    const known = trimmed !== null && trimmed in INTAKE_REJECTION_CODES;
    const explanation = known
        ? INTAKE_REJECTION_CODES[trimmed]
        : (message?.trim() || 'the platform refused this prospect');
    return {
        route: 'dm_only',
        code: trimmed,
        known,
        reason: trimmed ? `${trimmed}: ${explanation}` : explanation!,
    };
}
export interface Routing {
    lane: 'email' | 'dm_only';
    noProof: boolean;
    failed: boolean;
    reason: string;
}
export function failureReasonOf(row: Pick<RequestRow, 'stage_reason' | 'failure_reason'>): string | null {
    const stage = row.stage_reason?.trim();
    if (stage)
        return stage;
    const failure = row.failure_reason?.trim();
    return failure ? failure : null;
}
export function routeAfterRequest(row: Pick<RequestRow, 'status' | 'match_count'> & Partial<Pick<RequestRow, 'stage_reason' | 'failure_reason'>>): Routing {
    if (row.status === 'failed') {
        const why = failureReasonOf(row);
        return {
            lane: 'dm_only',
            noProof: false,
            failed: true,
            reason: why ? `the platform could not complete this run: ${why}` : 'the platform could not complete this run',
        };
    }
    if (row.status === 'no_proof') {
        return {
            lane: 'dm_only',
            noProof: true,
            failed: false,
            reason: 'platform found no live matches for this company',
        };
    }
    if (row.match_count !== null && row.match_count !== undefined && row.match_count <= 0) {
        return { lane: 'dm_only', noProof: true, failed: false, reason: 'match run returned zero matches' };
    }
    if (row.status === 'suppressed') {
        return { lane: 'dm_only', noProof: false, failed: false, reason: 'mailbox suppressed platform-side' };
    }
    return { lane: 'email', noProof: false, failed: false, reason: `request is ${row.status}` };
}
export function renderDrifted(previousHash: string | null | undefined, row: Pick<RequestRow, 'status' | 'content_hash'>): boolean {
    if (row.status !== 'awaiting_approval')
        return false;
    const before = previousHash?.trim();
    const after = row.content_hash?.trim();
    if (!before || !after)
        return false;
    return before !== after;
}
export function renderedBytes(row: RequestRow): {
    subject: string | null;
    text: string;
    html: string | null;
} | null {
    const text = row.rendered_body_text ?? null;
    const html = row.rendered_body_html ?? null;
    if (!text && !html)
        return null;
    return { subject: row.rendered_subject ?? null, text: text ?? '', html };
}
export function dedupeByEventKey(events: BridgeEvent[]): BridgeEvent[] {
    const seen = new Map<string, BridgeEvent>();
    for (const event of events)
        seen.set(event.event_key, event);
    return [...seen.values()].sort((a, b) => a.seq - b.seq);
}
export interface EventResolution {
    touchId: number | null;
    prospectId: number | null;
}
export function bridgeEventsToOutcomes(events: BridgeEvent[], resolve: (event: BridgeEvent) => EventResolution): PlatformOutcome[] {
    return dedupeByEventKey(events).map((event) => {
        const { touchId, prospectId } = resolve(event);
        return {
            sequence: event.seq,
            eventKey: event.event_key,
            refSlug: touchId === null ? null : `li-t${touchId}`,
            prospectId,
            email: null,
            kind: event.kind,
            occurredAt: event.occurred_at,
            payload: {
                ...((event.payload as Record<string, unknown> | null) ?? {}),
                bridgeRequestId: event.request_id ?? null,
                prospectRef: event.prospect_ref ?? null,
            },
        };
    });
}
export type PushResult = {
    ok: true;
    requestId: string;
    status: BridgeStatus;
} | {
    ok: false;
    kind: 'rejected';
    status: number;
    code: string | null;
    reason: string;
};
export type GetResult = {
    ok: true;
    row: RequestRow;
} | {
    ok: false;
    kind: 'not_found';
    reason: string;
};
export type ApproveResult = {
    ok: true;
    status: BridgeStatus;
} | {
    ok: false;
    kind: 'hash_mismatch';
    reason: string;
} | {
    ok: false;
    kind: 'wrong_state';
    reason: string;
    code: string | null;
    status: number;
};
export type SkipResult = {
    ok: boolean;
    status: number;
    code: string | null;
    reason: string | null;
};
export interface EventsResult {
    events: BridgeEvent[];
    highestSeq: number;
}
export class BridgeClient {
    constructor(private readonly transport: BridgeTransport | null, readonly available: boolean, readonly unavailableReason: string) { }
    static fromConfig(fetchImpl?: typeof fetch): BridgeClient {
        if (!config.bridge.enabled) {
            return new BridgeClient(null, false, 'GROWTH_BRIDGE_ENABLED is false');
        }
        if (!config.bridge.baseUrl || !config.bridge.serviceKey) {
            return new BridgeClient(null, false, 'bridge base URL or service key is not set');
        }
        const transport = httpTransport({
            baseUrl: config.bridge.baseUrl,
            serviceKey: config.bridge.serviceKey,
            timeoutMs: config.bridge.timeoutMs,
            ...(fetchImpl ? { fetchImpl } : {}),
        });
        return new BridgeClient(transport, true, 'available');
    }
    static withTransport(transport: BridgeTransport): BridgeClient {
        return new BridgeClient(transport, true, 'available');
    }
    private call(req: BridgeHttpRequest): Promise<BridgeHttpResponse> {
        if (!this.transport) {
            throw new BridgeError(`bridge is not available: ${this.unavailableReason}`, 'unavailable');
        }
        return this.transport(req);
    }
    private parse<T>(schema: z.ZodType<T>, res: BridgeHttpResponse, path: string): T {
        const parsed = schema.safeParse(res.body);
        if (!parsed.success) {
            throw new BridgeError(`bridge response for ${path} does not match the contract`, 'schema_drift', {
                status: res.status,
                issues: parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`),
            });
        }
        return parsed.data;
    }
    private guardCommonFailures(res: BridgeHttpResponse, path: string): void {
        if (res.status === 401 || res.status === 403) {
            throw new BridgeError(`bridge rejected the service key on ${path}`, 'auth');
        }
        if (res.status === 404 && path === '/prospects') {
            throw new BridgeError('bridge routes are 404 — the flag is off or the key is unset', 'unavailable');
        }
        if (res.status >= 500) {
            throw new BridgeError(`bridge returned ${res.status} on ${path}`, 'server', res.body);
        }
    }
    async pushProspect(input: PushProspectInput): Promise<PushResult> {
        const res = await this.call({
            method: 'POST',
            path: '/prospects',
            body: {
                prospect_ref: input.prospectRef,
                campaign_key: input.campaignKey,
                company: { name: input.company.name, website: input.company.website },
                contact: {
                    email: input.contact.email,
                    first_name: input.contact.firstName,
                    last_name: input.contact.lastName,
                    linkedin_url: input.contact.linkedinUrl,
                },
                icp_score: input.icpScore,
                persona: input.persona,
            },
        });
        this.guardCommonFailures(res, '/prospects');
        if (res.status === 422) {
            const { code, message } = readError(res.body);
            return {
                ok: false,
                kind: 'rejected',
                status: res.status,
                code,
                reason: readReason(res.body) ?? message ?? 'the bridge refused this prospect',
            };
        }
        if (res.status !== 200 && res.status !== 201) {
            return {
                ok: false,
                kind: 'rejected',
                status: res.status,
                code: readError(res.body).code,
                reason: readReason(res.body) ?? `unexpected status ${res.status}`,
            };
        }
        const body = this.parse(PushResponseSchema, res, '/prospects');
        return { ok: true, requestId: body.request_id, status: body.status };
    }
    async getRequest(requestId: string): Promise<GetResult> {
        const path = `/requests/${requestId}`;
        const res = await this.call({ method: 'GET', path });
        this.guardCommonFailures(res, path);
        if (res.status === 404) {
            return { ok: false, kind: 'not_found', reason: `bridge has no request ${requestId}` };
        }
        return { ok: true, row: this.parse(RequestRowSchema, res, path) };
    }
    async approve(requestId: string, hash: string, approvedBy: string): Promise<ApproveResult> {
        const path = `/requests/${requestId}/approve`;
        const res = await this.call({
            method: 'POST',
            path,
            body: { content_hash: hash, approved_by: approvedBy },
        });
        this.guardCommonFailures(res, path);
        if (res.status === 409) {
            return {
                ok: false,
                kind: 'hash_mismatch',
                reason: readReason(res.body) ??
                    'the platform re-rendered this email after it was shown — re-approve the new wording',
            };
        }
        if (res.status !== 200) {
            const { code } = readError(res.body);
            return {
                ok: false,
                kind: 'wrong_state',
                status: res.status,
                code,
                reason: readReason(res.body) ?? `approve returned ${res.status}`,
            };
        }
        const body = this.parse(z.object({ status: StatusSchema }).passthrough(), res, path);
        return { ok: true, status: body.status };
    }
    async skip(requestId: string, reason: string): Promise<SkipResult> {
        const path = `/requests/${requestId}/skip`;
        const res = await this.call({ method: 'POST', path, body: { reason } });
        this.guardCommonFailures(res, path);
        const { code } = readError(res.body);
        return {
            ok: res.status === 200,
            status: res.status,
            code: res.status === 200 ? null : code,
            reason: res.status === 200 ? null : readReason(res.body),
        };
    }
    async fetchEvents(after: number, limit = config.bridge.eventPageSize): Promise<EventsResult> {
        const path = '/events';
        const res = await this.call({ method: 'GET', path, query: { after, limit } });
        this.guardCommonFailures(res, path);
        const parsed = this.parse(EventsResponseSchema, res, path);
        const events = Array.isArray(parsed) ? parsed : parsed.events;
        return {
            events,
            highestSeq: events.reduce((max, e) => Math.max(max, e.seq), after),
        };
    }
    async suppressionCheck(email: string): Promise<{
        suppressed: boolean;
        reasons: string[];
    }> {
        const path = '/suppression-check';
        const res = await this.call({ method: 'GET', path, query: { email } });
        this.guardCommonFailures(res, path);
        const body = this.parse(SuppressionSchema, res, path);
        return { suppressed: body.suppressed, reasons: body.reasons ?? [] };
    }
}
export function readError(body: unknown): {
    code: string | null;
    message: string | null;
} {
    if (!body || typeof body !== 'object')
        return { code: null, message: null };
    const record = body as Record<string, unknown>;
    const raw = record.error;
    const code = typeof raw === 'string' && /^[a-z0-9][a-z0-9_.-]*$/i.test(raw.trim()) ? raw.trim() : null;
    let message: string | null = null;
    for (const key of ['message', 'reason', 'detail', 'error']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() && value.trim() !== code) {
            message = value.trim();
            break;
        }
    }
    return { code, message };
}
export function readReason(body: unknown): string | null {
    const { code, message } = readError(body);
    if (code && message)
        return `${code}: ${message}`;
    return code ?? message;
}
