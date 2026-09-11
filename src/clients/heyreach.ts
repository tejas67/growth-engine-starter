import { readSettings } from '../../config/local.js';
import { config, type RunMode } from '../../config/index.js';
import { rampCapsFor } from '../guardrails/ramp.js';
import { logger } from '../lib/log.js';
import type { FetchLike } from './apify.js';
const log = logger('heyreach');
export interface DmRequest {
    linkedinUrl: string;
    message: string;
    note?: string | null;
    kind: 'dm' | 'connect';
    campaignId: string;
    linkedInAccountId: string;
    firstName?: string | null;
    lastName?: string | null;
    correlationId: string;
}
export interface DmResult {
    dispatched: boolean;
    dryRun: boolean;
    providerMessageId: string | null;
    providerThreadId: string | null;
    reason: string;
}
export interface HeyReachReply {
    providerMessageId: string;
    providerThreadId: string | null;
    correlationId: string | null;
    linkedinUrl: string | null;
    text: string;
    receivedAt: Date;
}
export interface AccountStatus {
    connected: boolean;
    restricted: boolean;
    detail: string;
    accountId?: string;
    name?: string | null;
    profileUrl?: string | null;
}
export interface SendOptions {
    now?: Date;
    rampStartDate?: string | null;
    sentToday?: {
        dms: number;
        connects: number;
    };
}
function refused(reason: string): DmResult {
    return {
        dispatched: false,
        dryRun: true,
        providerMessageId: null,
        providerThreadId: null,
        reason,
    };
}
export interface HeyReachDeps {
    fetchImpl?: FetchLike;
}
export class HeyReachClient {
    private readonly fetchImpl: FetchLike;
    constructor(private readonly apiKey: string = config.send.heyreachKey, private readonly mode: RunMode = config.dryRun ? 'dry_run' : 'live', deps: HeyReachDeps = {}) {
        this.fetchImpl = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    }
    get runMode(): RunMode {
        return this.mode;
    }
    get degraded(): boolean {
        return this.mode === 'live' && !this.apiKey;
    }
    async send(req: DmRequest, opts: SendOptions = {}): Promise<DmResult> {
        if (req.kind === 'connect' && req.message.length > 300) {
            return refused(`connection note is ${req.message.length} chars; LinkedIn caps it at 300`);
        }
        if (req.note && req.note.length > 300) {
            return refused(`connection note is ${req.note.length} chars; LinkedIn caps it at 300`);
        }
        const capRefusal = this.rampRefusal(req, opts);
        if (capRefusal) {
            log.warn('dispatch refused at the client — ramp cap', {
                kind: req.kind,
                correlationId: req.correlationId,
                reason: capRefusal.reason,
            });
            return capRefusal;
        }
        if (this.mode !== 'live') {
            log.info('DRY RUN — would send', {
                kind: req.kind,
                to: req.linkedinUrl,
                chars: req.message.length,
                correlationId: req.correlationId,
                preview: req.message.slice(0, 120),
            });
            return refused('dry run — nothing was transmitted');
        }
        if (!this.apiKey) {
            log.warn('DEGRADED to dry run: HEYREACH_API_KEY is not set — nothing was transmitted', {
                correlationId: req.correlationId,
            });
            return refused('HEYREACH_API_KEY absent — degraded to dry run, nothing was transmitted');
        }
        if (!req.campaignId) {
            log.warn('DEGRADED to dry run: no HeyReach campaign id configured', {
                correlationId: req.correlationId,
            });
            return refused('HEYREACH_CAMPAIGN_ID absent — degraded to dry run, nothing was transmitted');
        }
        if (!req.linkedInAccountId) {
            log.warn('DEGRADED to dry run: no HeyReach LinkedIn account id configured', {
                correlationId: req.correlationId,
            });
            return refused('HEYREACH_LINKEDIN_ACCOUNT_ID absent — degraded to dry run, nothing was transmitted');
        }
        return this.addLeadToCampaign(req);
    }
    private rampRefusal(req: DmRequest, opts: SendOptions): DmResult | null {
        const sentToday = opts.sentToday;
        if (!sentToday)
            return null;
        const caps = rampCapsFor(opts.now ?? new Date(), opts.rampStartDate ?? null);
        if (caps.phase === 'paused') {
            return refused('LinkedIn ramp is paused — nothing was transmitted');
        }
        if (req.kind === 'dm' && sentToday.dms >= caps.dmsPerDay) {
            return refused(`DM ramp cap reached (${sentToday.dms}/${caps.dmsPerDay} today, ${caps.phase}) — nothing was transmitted`);
        }
        if (req.kind === 'connect' && sentToday.connects >= caps.invitesPerDay) {
            return refused(`invite ramp cap reached (${sentToday.connects}/${caps.invitesPerDay} today, ${caps.phase}) — nothing was transmitted`);
        }
        return null;
    }
    private async addLeadToCampaign(req: DmRequest): Promise<DmResult> {
        const path = '/campaign/AddLeadsToCampaignV2';
        const accountId = Number(req.linkedInAccountId);
        const res = await this.fetchImpl(`${config.send.heyreachBaseUrl}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-API-KEY': this.apiKey },
            signal: AbortSignal.timeout(20000),
            redirect: 'error',
            body: JSON.stringify({
                resumeFinishedCampaign: readSettings().integrations.resumeFinishedCampaign,
                campaignId: Number.isFinite(Number(req.campaignId)) ? Number(req.campaignId) : req.campaignId,
                accountLeadPairs: [
                    {
                        linkedInAccountId: Number.isFinite(accountId) ? accountId : req.linkedInAccountId,
                        lead: {
                            profileUrl: req.linkedinUrl,
                            ...(req.firstName ? { firstName: req.firstName } : {}),
                            ...(req.lastName ? { lastName: req.lastName } : {}),
                            customUserFields: [
                                { name: 'correlationId', value: req.correlationId },
                                { name: 'touchKind', value: req.kind },
                                { name: 'message', value: req.message },
                                ...(req.note ? [{ name: 'note', value: req.note }] : []),
                            ],
                        },
                    },
                ],
            }),
        });
        if (!res.ok) {
            throw new Error(`heyreach ${path} failed: ${res.status}`);
        }
        const body = (await res.json().catch(() => null)) as {
            addedLeadsCount?: number;
            updatedLeadsCount?: number;
            failedLeadsCount?: number;
            messageId?: string;
            threadId?: string;
            leadId?: string;
            id?: string;
        } | null;
        const failed = Number(body?.failedLeadsCount ?? 0);
        const accepted = Number(body?.addedLeadsCount ?? 0) + Number(body?.updatedLeadsCount ?? 0);
        if (!body || !Number.isFinite(accepted) || failed !== 0 || accepted !== 1) {
            throw new Error('HeyReach did not confirm exactly one accepted lead; check the campaign before retrying');
        }
        const providerMessageId = body?.messageId ?? body?.leadId ?? body?.id ?? null;
        return {
            dispatched: true,
            dryRun: false,
            providerMessageId: providerMessageId ? String(providerMessageId) : null,
            providerThreadId: body?.threadId ? String(body.threadId) : null,
            reason: 'dispatched',
        };
    }
    async fetchReplies(since: Date): Promise<HeyReachReply[]> {
        if (this.mode !== 'live')
            return [];
        if (!this.apiKey) {
            log.warn('DEGRADED: HEYREACH_API_KEY is not set — DM reply detection is off', {
                consequence: 'replies are visible only in the LinkedIn inbox until a key is set',
            });
            return [];
        }
        const res = await this.fetchImpl(`${config.send.heyreachBaseUrl}/inbox/GetConversations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-API-KEY': this.apiKey },
            body: JSON.stringify({ since: since.toISOString(), limit: 100 }),
        });
        if (!res.ok)
            throw new Error(`heyreach inbox failed: ${res.status}`);
        const body = (await res.json()) as {
            items?: Array<Record<string, unknown>>;
        };
        return (body.items ?? []).map((item) => ({
            providerMessageId: String(item.id ?? ''),
            providerThreadId: item.threadId ? String(item.threadId) : null,
            correlationId: (item.customFields as Record<string, string> | undefined)?.correlationId ?? null,
            linkedinUrl: item.profileUrl ? String(item.profileUrl) : null,
            text: String(item.lastMessage ?? ''),
            receivedAt: new Date(String(item.lastMessageAt ?? Date.now())),
        }));
    }
    async senderIdentity(accountId = config.send.heyreachLinkedInAccountId): Promise<AccountStatus> {
        if (!this.apiKey || !accountId) {
            return { connected: false, restricted: false, detail: 'LinkedIn sender is not configured' };
        }
        const res = await this.fetchImpl(`${config.send.heyreachBaseUrl}/li_account/GetById?accountId=${encodeURIComponent(accountId)}`, {
            headers: { 'X-API-KEY': this.apiKey },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            throw new Error(`heyreach sender lookup failed: ${res.status}`);
        const seat = await res.json() as {
            id?: number;
            firstName?: string;
            lastName?: string;
            profileUrl?: string;
            status?: string;
        };
        if (String(seat.id) !== accountId)
            throw new Error('heyreach sender lookup returned a different account');
        const connectionRes = await this.fetchImpl(`${config.send.heyreachBaseUrl}/li_account/GetAccountStatus/${encodeURIComponent(accountId)}`, {
            headers: { 'X-API-KEY': this.apiKey },
            signal: AbortSignal.timeout(5000),
        });
        if (!connectionRes.ok)
            throw new Error(`heyreach connection lookup failed: ${connectionRes.status}`);
        const connection = await connectionRes.json() as {
            accountId?: number | string;
            status?: string;
            failureReason?: string | null;
        };
        if (connection.accountId !== undefined && String(connection.accountId) !== accountId) {
            throw new Error('heyreach connection lookup returned a different account');
        }
        const connected = connection.status === 'Connected';
        const status = [seat.status, connection.status, connection.failureReason].filter(Boolean).join(' ').toLowerCase();
        const restricted = /restrict|warn|block/.test(status);
        let profileUrl: string | null = null;
        try {
            const url = new URL(seat.profileUrl ?? '');
            if (url.protocol === 'https:' && /^(www\.)?linkedin\.com$/.test(url.hostname) && url.pathname.startsWith('/in/'))
                profileUrl = url.href;
        }
        catch { }
        return { accountId, name: [seat.firstName, seat.lastName].filter(Boolean).join(' ') || null,
            profileUrl, connected, restricted,
            detail: restricted ? 'LinkedIn account restricted' : connected ? 'Connected' : 'Reconnect in HeyReach' };
    }
    async accountStatus(): Promise<AccountStatus> {
        if (this.mode !== 'live') {
            return { connected: false, restricted: false, detail: 'dry run — no seat queried' };
        }
        return this.senderIdentity();
    }
    async checkAuth(): Promise<{
        ok: boolean;
        detail: string;
    }> {
        if (!this.apiKey)
            return { ok: false, detail: 'HEYREACH_API_KEY absent' };
        const res = await this.fetchImpl(`${config.send.heyreachBaseUrl}/auth/CheckApiKey`, {
            headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (res.ok)
            return { ok: true, detail: 'key accepted' };
        if (res.status !== 404 && res.status !== 405) {
            return { ok: false, detail: `HTTP ${res.status} from /auth/CheckApiKey` };
        }
        const seatRes = await this.fetchImpl(`${config.send.heyreachBaseUrl}/li_account/GetAll`, {
            method: 'POST',
            headers: { 'X-API-KEY': this.apiKey, 'content-type': 'application/json' },
            body: JSON.stringify({ offset: 0, limit: 1 }),
            signal: AbortSignal.timeout(10000),
        });
        if (!seatRes.ok) {
            return { ok: false, detail: `HTTP ${seatRes.status} from the seat list (CheckApiKey 404'd too)` };
        }
        const body = (await seatRes.json().catch(() => null)) as {
            items?: unknown[];
        } | null;
        return { ok: true, detail: `key accepted; ${body?.items?.length ?? 0} seat(s) visible` };
    }
}
