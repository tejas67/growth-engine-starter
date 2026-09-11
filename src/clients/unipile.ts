import { config, type UnipileMode } from '../../config/index.js';
import { logger } from '../lib/log.js';
import type { FetchLike } from './apify.js';
const log = logger('unipile');
export class UnipileError extends Error {
    constructor(message: string, readonly status: number, readonly retryAfterMs: number | null = null) {
        super(message);
        this.name = 'UnipileError';
    }
    get retryable(): boolean {
        return this.status === 429 || this.status >= 500;
    }
    get rateLimited(): boolean {
        return this.status === 429;
    }
    get notFound(): boolean {
        return this.status === 404;
    }
}
export class UnipileBudgetExhausted extends Error {
    constructor(readonly kind: UnipileCallKind, readonly reason: string) {
        super(`unipile ${kind} refused: ${reason}`);
        this.name = 'UnipileBudgetExhausted';
    }
}
export type UnipileCallKind = 'accounts' | 'posts' | 'reactions' | 'comments' | 'profile' | 'company';
export function budgetFor(kind: UnipileCallKind): 'calls' | 'profiles' | null {
    switch (kind) {
        case 'posts':
        case 'reactions':
        case 'comments':
            return 'calls';
        case 'profile':
        case 'company':
            return 'profiles';
        case 'accounts':
            return null;
    }
}
export interface UnipileCallLedger {
    admit(kind: UnipileCallKind): {
        ok: true;
        waitMs?: number;
    } | {
        ok: false;
        reason: string;
    } | Promise<{
        ok: true;
        waitMs?: number;
    } | {
        ok: false;
        reason: string;
    }>;
    record(kind: UnipileCallKind): Promise<void>;
    block?(error: UnipileError): Promise<void>;
}
export interface DailyCallBudgetState {
    callsUsed: number;
    callCap: number;
    profilesUsed: number;
    profileCap: number;
}
export class DailyCallBudget implements UnipileCallLedger {
    private readonly state: DailyCallBudgetState;
    constructor(state: DailyCallBudgetState, private readonly onRecord: (kind: UnipileCallKind) => Promise<void> = async () => undefined) {
        this.state = { ...state };
    }
    get snapshot(): DailyCallBudgetState {
        return { ...this.state };
    }
    admit(kind: UnipileCallKind): {
        ok: true;
    } | {
        ok: false;
        reason: string;
    } {
        const bucket = budgetFor(kind);
        if (bucket === null)
            return { ok: true };
        if (bucket === 'calls' && this.state.callsUsed >= this.state.callCap) {
            return {
                ok: false,
                reason: `daily call cap reached (${this.state.callsUsed}/${this.state.callCap}) — stopping for the day`,
            };
        }
        if (bucket === 'profiles' && this.state.profilesUsed >= this.state.profileCap) {
            return {
                ok: false,
                reason: `daily profile cap reached (${this.state.profilesUsed}/${this.state.profileCap}) — stopping for the day`,
            };
        }
        return { ok: true };
    }
    async record(kind: UnipileCallKind): Promise<void> {
        const bucket = budgetFor(kind);
        if (bucket === 'calls')
            this.state.callsUsed += 1;
        if (bucket === 'profiles')
            this.state.profilesUsed += 1;
        await this.onRecord(kind);
    }
}
export const UNMETERED: UnipileCallLedger = {
    admit: () => ({ ok: true }),
    record: async () => undefined,
};
export interface UnipileAccount {
    id: string;
    type: string;
    name: string | null;
    status: string | null;
}
export interface UnipileProfile {
    providerId: string;
    publicIdentifier: string | null;
    firstName: string | null;
    lastName: string | null;
    headline: string | null;
    location: string | null;
    isOpenProfile: boolean | null;
    isPremium: boolean | null;
    networkDistance: string | null;
    followerCount: number | null;
    connectionsCount: number | null;
    raw: unknown;
}
export interface UnipileCompany {
    id: string;
    name: string | null;
    raw: unknown;
}
export interface UnipileResponse<T> {
    data: T;
    effectiveMode: UnipileMode;
    degradedReason: string | null;
    calls: number;
}
export interface UnipilePage {
    items: unknown[];
    cursor: string | null;
}
function asString(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function asNumber(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asBool(v: unknown): boolean | null {
    return typeof v === 'boolean' ? v : null;
}
export function parseProfile(body: unknown): UnipileProfile | null {
    const obj = (body ?? null) as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object')
        return null;
    const providerId = asString(obj.provider_id);
    if (!providerId)
        return null;
    return {
        providerId,
        publicIdentifier: asString(obj.public_identifier),
        firstName: asString(obj.first_name),
        lastName: asString(obj.last_name),
        headline: asString(obj.headline),
        location: asString(obj.location),
        isOpenProfile: asBool(obj.is_open_profile),
        isPremium: asBool(obj.is_premium),
        networkDistance: asString(obj.network_distance),
        followerCount: asNumber(obj.follower_count),
        connectionsCount: asNumber(obj.connections_count),
        raw: body,
    };
}
function parseAccounts(body: unknown): UnipileAccount[] {
    const items = (body as {
        items?: unknown[];
    } | null)?.items;
    if (!Array.isArray(items))
        return [];
    return items
        .map((item) => {
        const obj = (item ?? {}) as Record<string, unknown>;
        const id = asString(obj.id);
        if (!id)
            return null;
        const sources = Array.isArray(obj.sources) ? (obj.sources as Array<Record<string, unknown>>) : [];
        return {
            id,
            type: asString(obj.type) ?? 'UNKNOWN',
            name: asString(obj.name),
            status: asString(obj.status) ?? asString(sources[0]?.status) ?? null,
        };
    })
        .filter((a): a is UnipileAccount => a !== null);
}
function parsePage(body: unknown): UnipilePage {
    const obj = (body ?? {}) as {
        items?: unknown;
        paging?: {
            cursor?: unknown;
        } | null;
        cursor?: unknown;
    };
    if (!Array.isArray(obj.items))
        throw new Error('unipile page missing items array — response shape changed');
    const items = obj.items;
    const cursor = asString(obj.paging?.cursor) ?? asString(obj.cursor);
    return { items, cursor };
}
export function jitterMs(minMs: number, maxMs: number, random: () => number = Math.random): number {
    const lo = Math.max(0, Math.min(minMs, maxMs));
    const hi = Math.max(minMs, maxMs);
    return Math.round(lo + random() * (hi - lo));
}
export interface UnipileDeps {
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    ledger?: UnipileCallLedger;
}
export interface UnipileCredentials {
    dsn: string;
    apiKey: string;
    accountId: string;
}
export class UnipileClient {
    private readonly fetchImpl: FetchLike;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;
    private readonly ledger: UnipileCallLedger;
    private callsMade = 0;
    constructor(private readonly creds: UnipileCredentials = {
        dsn: config.unipile.dsn,
        apiKey: config.unipile.apiKey,
        accountId: config.unipile.accountId,
    }, private readonly mode: UnipileMode = config.unipile.mode, deps: UnipileDeps = {}) {
        this.fetchImpl = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
        this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.random = deps.random ?? Math.random;
        this.ledger = deps.ledger ?? UNMETERED;
    }
    get runMode(): UnipileMode {
        return this.mode;
    }
    get missingCredential(): string | null {
        if (!this.creds.dsn)
            return 'UNIPILE_DSN';
        if (!this.creds.apiKey)
            return 'UNIPILE_API_KEY';
        if (!this.creds.accountId)
            return 'UNIPILE_ACCOUNT_ID';
        return null;
    }
    get degraded(): boolean {
        return this.mode === 'live' && this.missingCredential !== null;
    }
    async listAccounts(): Promise<UnipileAccount[]> {
        if (this.mode !== 'live')
            throw new Error('unipile is not live — no account list was read');
        if (!this.creds.dsn || !this.creds.apiKey) {
            throw new Error(`${!this.creds.dsn ? 'UNIPILE_DSN' : 'UNIPILE_API_KEY'} absent — no account list was read`);
        }
        const body = await this.get('accounts', `/api/v1/accounts`, {}, false);
        return parseAccounts(body);
    }
    async getUser(identifier: string): Promise<UnipileResponse<UnipileProfile | null>> {
        const offline = this.offline<UnipileProfile | null>(null, 'profile', identifier);
        if (offline)
            return offline;
        const body = await this.get('profile', `/api/v1/users/${encodeURIComponent(identifier)}`);
        const profile = parseProfile(body);
        if (!profile) {
            throw new Error(`unipile profile ${identifier} returned no provider_id — response shape changed`);
        }
        return { data: profile, effectiveMode: 'live', degradedReason: null, calls: 1 };
    }
    async getCompany(identifier: string): Promise<UnipileResponse<UnipileCompany | null>> {
        const offline = this.offline<UnipileCompany | null>(null, 'company', identifier);
        if (offline)
            return offline;
        const body = await this.get('company', `/api/v1/linkedin/company/${encodeURIComponent(identifier)}`);
        const obj = (body ?? {}) as Record<string, unknown>;
        const id = asString(obj.id) ?? (typeof obj.id === 'number' ? String(obj.id) : null);
        if (!id)
            throw new Error(`unipile company ${identifier} returned no id — response shape changed`);
        return {
            data: { id, name: asString(obj.name), raw: body },
            effectiveMode: 'live',
            degradedReason: null,
            calls: 1,
        };
    }
    async listPosts(providerId: string, opts: {
        isCompany?: boolean;
        limit?: number;
    } = {}): Promise<UnipileResponse<unknown[]>> {
        const offline = this.offline<unknown[]>([], 'posts', providerId);
        if (offline)
            return offline;
        const params: Record<string, string> = { limit: String(opts.limit ?? config.unipile.postsPerSeed) };
        if (opts.isCompany)
            params.is_company = 'true';
        const body = await this.get('posts', `/api/v1/users/${encodeURIComponent(providerId)}/posts`, params);
        return { data: parsePage(body).items, effectiveMode: 'live', degradedReason: null, calls: 1 };
    }
    async listReactions(socialId: string, max: number): Promise<UnipileResponse<unknown[]>> {
        return this.paged('reactions', `/api/v1/posts/${encodeURIComponent(socialId)}/reactions`, socialId, max);
    }
    async listComments(socialId: string, max: number): Promise<UnipileResponse<unknown[]>> {
        return this.paged('comments', `/api/v1/posts/${encodeURIComponent(socialId)}/comments`, socialId, max);
    }
    async listEngagerPage(kind: 'reactions' | 'comments', socialId: string, cursor: string | null): Promise<UnipilePage> {
        if (this.mode !== 'live' || this.missingCredential)
            throw new Error('Unipile page read requires live credentials');
        const params: Record<string, string> = { limit: String(Math.min(100, Math.max(1, config.unipile.pageSize))) };
        if (cursor)
            params.cursor = cursor;
        return parsePage(await this.get(kind, `/api/v1/posts/${encodeURIComponent(socialId)}/${kind}`, params));
    }
    private offline<T>(empty: T, kind: UnipileCallKind, target: string): UnipileResponse<T> | null {
        if (this.mode !== 'live') {
            return {
                data: empty,
                effectiveMode: 'dry_run',
                degradedReason: `GROWTH_UNIPILE_MODE=${this.mode} — no live call was made`,
                calls: 0,
            };
        }
        const missing = this.missingCredential;
        if (missing) {
            log.warn(`DEGRADED to dry run: ${missing} is not set — no live call was made`, { kind, target });
            return {
                data: empty,
                effectiveMode: 'dry_run',
                degradedReason: `${missing} absent — no live call was made`,
                calls: 0,
            };
        }
        return null;
    }
    private async paged(kind: UnipileCallKind, path: string, target: string, max: number): Promise<UnipileResponse<unknown[]>> {
        const offline = this.offline<unknown[]>([], kind, target);
        if (offline)
            return offline;
        const items: unknown[] = [];
        let cursor: string | null = null;
        let calls = 0;
        const cursors = new Set<string>();
        const pageSize = Math.max(1, Math.min(config.unipile.pageSize, max));
        while (items.length < max) {
            const params: Record<string, string> = { limit: String(pageSize) };
            if (cursor)
                params.cursor = cursor;
            const page = parsePage(await this.get(kind, path, params));
            calls += 1;
            items.push(...page.items);
            if (!page.cursor || page.items.length === 0)
                break;
            if (cursors.has(page.cursor))
                throw new Error('unipile repeated pagination cursor');
            cursors.add(page.cursor);
            cursor = page.cursor;
        }
        return { data: items.slice(0, max), effectiveMode: 'live', degradedReason: null, calls };
    }
    private async get(kind: UnipileCallKind, path: string, params: Record<string, string> = {}, withAccount = true): Promise<unknown> {
        const admitted = await this.ledger.admit(kind);
        if (!admitted.ok)
            throw new UnipileBudgetExhausted(kind, admitted.reason);
        if (admitted.waitMs !== undefined) {
            await this.sleep(admitted.waitMs);
        }
        else if (this.callsMade > 0) {
            await this.sleep(jitterMs(config.unipile.minDelayMs, config.unipile.maxDelayMs, this.random));
        }
        this.callsMade += 1;
        const url = new URL(path, this.creds.dsn);
        if (withAccount)
            url.searchParams.set('account_id', this.creds.accountId);
        for (const [k, v] of Object.entries(params))
            url.searchParams.set(k, v);
        let res: Response;
        try {
            res = await this.fetchImpl(url.toString(), {
                method: 'GET',
                headers: { 'X-API-KEY': this.creds.apiKey, accept: 'application/json' },
                signal: AbortSignal.timeout(config.unipile.timeoutMs),
            });
        }
        catch (cause) {
            const error = new UnipileError(`unipile ${kind} transport failed: ${(cause as Error).message}`, 503);
            await this.ledger.block?.(error);
            throw error;
        }
        finally {
            await this.ledger.record(kind);
        }
        const text = await res.text().catch(() => '');
        if (!res.ok) {
            const retryAfter = res.headers.get('retry-after');
            const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;
            const error = new UnipileError(`unipile ${kind} ${res.status} for ${path}: ${text.slice(0, 200) || res.statusText}`, res.status, retryAfterMs);
            if ([401, 403, 429].includes(res.status) || res.status >= 500)
                await this.ledger.block?.(error);
            throw error;
        }
        if (!text)
            return null;
        try {
            return JSON.parse(text) as unknown;
        }
        catch {
            throw new Error(`unipile ${kind} returned non-JSON for ${path}: ${text.slice(0, 120)}`);
        }
    }
}
