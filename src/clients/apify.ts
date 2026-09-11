import { config, type CommentWindow, type PostedWindow, type RunMode, } from '../../config/index.js';
import { logger } from '../lib/log.js';
import { fixtureKey, readFixture, writeFixture } from './fixtures.js';
const log = logger('apify');
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type CostSource = 'apify_reported' | 'estimated' | 'none';
export interface ApifyRunResult {
    items: unknown[];
    mode: RunMode;
    effectiveMode: RunMode;
    costUsd: number;
    costSource: CostSource;
    fixtureKey: string;
    runId: string | null;
    degradedReason: string | null;
}
export interface PostsActorInput {
    targetUrls: string[];
    maxPosts: number;
    postedLimit: PostedWindow;
    postedLimitDate?: string;
    includeReposts: boolean;
    includeQuotePosts: boolean;
    scrapeReactions: boolean;
    maxReactions: number;
    scrapeComments: boolean;
    maxComments: number;
    commentsPostedLimit: CommentWindow;
    contextCountry: string;
}
export interface ReactionsActorInput {
    posts: string[];
    maxItems: number;
    profileScraperMode: 'short' | 'main';
    reactionTypeFilter?: string[];
}
export interface BuildPostsInputOptions {
    targetUrls: string[];
    maxPosts?: number;
    postedLimit?: PostedWindow;
    postedLimitDate?: string;
    scrapeReactions?: boolean;
    maxReactions?: number;
    scrapeComments?: boolean;
    maxComments?: number;
    commentsPostedLimit?: CommentWindow;
    contextCountry?: string;
}
export function buildPostsInput(opts: BuildPostsInputOptions): PostsActorInput {
    const input: PostsActorInput = {
        targetUrls: opts.targetUrls,
        maxPosts: opts.maxPosts ?? config.scrape.maxPosts,
        postedLimit: opts.postedLimit ?? config.scrape.postedWindow,
        includeReposts: true,
        includeQuotePosts: true,
        scrapeReactions: opts.scrapeReactions ?? false,
        maxReactions: opts.maxReactions ?? 0,
        scrapeComments: opts.scrapeComments ?? true,
        maxComments: opts.maxComments ?? config.scrape.maxComments,
        commentsPostedLimit: opts.commentsPostedLimit ?? config.scrape.commentsWindow,
        contextCountry: opts.contextCountry ?? config.scrape.contextCountry,
    };
    if (opts.postedLimitDate)
        input.postedLimitDate = opts.postedLimitDate;
    return input;
}
export interface BuildReactionsInputOptions {
    postUrls: string[];
    maxItems?: number;
    profileScraperMode?: 'short' | 'main';
    reactionTypeFilter?: string[];
}
export function buildReactionsInput(opts: BuildReactionsInputOptions): ReactionsActorInput {
    const input: ReactionsActorInput = {
        posts: opts.postUrls,
        maxItems: opts.maxItems ?? config.scrape.maxReactionsPerPost,
        profileScraperMode: opts.profileScraperMode ?? 'main',
    };
    if (opts.reactionTypeFilter?.length)
        input.reactionTypeFilter = opts.reactionTypeFilter;
    return input;
}
export interface ApifyDeps {
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMING-OUT']);
interface ApifyRunRecord {
    id: string;
    status: string;
    defaultDatasetId: string | null;
    usageTotalUsd: number | null;
    chargedEventCounts: Record<string, unknown> | null;
}
function parseRunRecord(body: unknown): ApifyRunRecord | null {
    const data = (body as {
        data?: Record<string, unknown>;
    } | null)?.data;
    if (!data || typeof data !== 'object')
        return null;
    const id = typeof data.id === 'string' ? data.id : null;
    if (!id)
        return null;
    return {
        id,
        status: typeof data.status === 'string' ? data.status : 'UNKNOWN',
        defaultDatasetId: typeof data.defaultDatasetId === 'string' ? data.defaultDatasetId : null,
        usageTotalUsd: typeof data.usageTotalUsd === 'number' ? data.usageTotalUsd : null,
        chargedEventCounts: data.chargedEventCounts && typeof data.chargedEventCounts === 'object'
            ? (data.chargedEventCounts as Record<string, unknown>)
            : null,
    };
}
export function targetKey(urls: string[]): string {
    return urls
        .map((url) => {
        const activity = /-activity-(\d{10,})/.exec(url) ?? /urn:li:activity:(\d+)/.exec(url);
        if (activity?.[1])
            return activity[1];
        const path = (url.split('?')[0] ?? '').replace(/\/+$/, '');
        return path.split('/').pop() ?? url;
    })
        .join('+')
        .toLowerCase();
}
export function estimateRunCost(items: unknown[], defaultUnitPrice: number): number {
    let total = 0;
    for (const item of items) {
        const obj = (item ?? {}) as Record<string, unknown>;
        if (typeof obj.commentary === 'string')
            total += config.scrape.costPerCommentUsd;
        else if (typeof obj.reactionType === 'string')
            total += config.scrape.costPerEngagerUsd;
        else if (obj.author && (obj.content !== undefined || obj.postedAt !== undefined)) {
            total += config.scrape.costPerPostUsd;
        }
        else
            total += defaultUnitPrice;
    }
    return Number(total.toFixed(4));
}
export class ApifyClient {
    private readonly fetchImpl: FetchLike;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    constructor(private readonly token: string = config.scrape.apifyToken, private readonly mode: RunMode = config.scrape.mode, deps: ApifyDeps = {}) {
        this.fetchImpl = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
        this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = deps.now ?? (() => Date.now());
    }
    get runMode(): RunMode {
        return this.mode;
    }
    get degraded(): boolean {
        return (this.mode === 'live' || this.mode === 'capture') && !this.token;
    }
    async runProfilePosts(input: PostsActorInput): Promise<ApifyRunResult> {
        const key = fixtureKey('profile-posts', targetKey(input.targetUrls));
        return this.run(config.scrape.actors.profilePosts, input, key, 'post');
    }
    async runCompanyPosts(input: PostsActorInput): Promise<ApifyRunResult> {
        const key = fixtureKey('company-posts', targetKey(input.targetUrls));
        return this.run(config.scrape.actors.companyPosts, input, key, 'post');
    }
    async runPostReactions(input: ReactionsActorInput): Promise<ApifyRunResult> {
        const key = fixtureKey('post-reactions', targetKey(input.posts));
        return this.run(config.scrape.actors.postReactions, input, key, 'engager');
    }
    async whoAmI(): Promise<{
        ok: boolean;
        detail: string;
    }> {
        if (!this.token)
            return { ok: false, detail: 'APIFY_TOKEN absent' };
        const res = await this.fetchImpl(`${config.scrape.apifyBaseUrl}/v2/users/me`, {
            headers: { authorization: `Bearer ${this.token}` },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok)
            return { ok: false, detail: `HTTP ${res.status}` };
        const body = (await res.json().catch(() => null)) as {
            data?: {
                username?: string;
            };
        } | null;
        return { ok: true, detail: `authenticated as ${body?.data?.username ?? 'unknown user'}` };
    }
    private async run(actor: string, input: unknown, key: string, unit: 'post' | 'engager'): Promise<ApifyRunResult> {
        const price = unit === 'post' ? config.scrape.costPerPostUsd : config.scrape.costPerEngagerUsd;
        if (this.mode === 'replay' || this.mode === 'dry_run') {
            return this.offline(key, this.mode, null);
        }
        if (!this.token) {
            const reason = 'APIFY_TOKEN absent — no live call was made';
            log.warn('DEGRADED to offline: APIFY_TOKEN is not set', {
                configuredMode: this.mode,
                actor,
                key,
            });
            return this.offline(key, 'dry_run', reason);
        }
        const base = config.scrape.apifyBaseUrl;
        const actorPath = actor.replace('/', '~');
        const startUrl = `${base}/v2/acts/${actorPath}/runs` +
            `?maxTotalChargeUsd=${encodeURIComponent(String(config.scrape.maxTotalChargeUsd))}`;
        const startRes = await this.fetchImpl(startUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify(input),
        });
        if (!startRes.ok) {
            throw new Error(`apify ${actor} start failed: ${startRes.status} ${await startRes.text().catch(() => '')}`);
        }
        const started = parseRunRecord(await startRes.json().catch(() => null));
        if (!started) {
            throw new Error(`apify ${actor} start returned no run id — response shape changed`);
        }
        const finished = await this.pollUntilTerminal(actor, started);
        if (finished.status !== 'SUCCEEDED') {
            throw new Error(`apify ${actor} run ${finished.id} ended ${finished.status}`);
        }
        if (!finished.defaultDatasetId) {
            throw new Error(`apify ${actor} run ${finished.id} succeeded with no dataset id`);
        }
        const items = await this.fetchDataset(actor, finished.defaultDatasetId);
        if (this.mode === 'capture') {
            const path = await writeFixture(key, items);
            log.info('captured fixture', { key, path, items: items.length });
        }
        const reported = finished.usageTotalUsd;
        const useReported = typeof reported === 'number' && Number.isFinite(reported) && reported > 0;
        const costUsd = useReported ? Number(reported.toFixed(4)) : estimateRunCost(items, price);
        if (!useReported) {
            log.info('apify reported no charge — falling back to the per-result estimate', {
                runId: finished.id,
                items: items.length,
                unit,
            });
        }
        return {
            items,
            mode: this.mode,
            effectiveMode: this.mode,
            costUsd,
            costSource: useReported ? 'apify_reported' : 'estimated',
            fixtureKey: key,
            runId: finished.id,
            degradedReason: null,
        };
    }
    private async pollUntilTerminal(actor: string, started: ApifyRunRecord): Promise<ApifyRunRecord> {
        if (TERMINAL_STATUSES.has(started.status))
            return started;
        const deadline = this.now() + config.scrape.runTimeoutMs;
        let latest = started;
        for (;;) {
            if (this.now() >= deadline) {
                await this.abortRun(latest.id);
                throw new Error(`apify ${actor} run ${latest.id} exceeded ${config.scrape.runTimeoutMs}ms ` +
                    `(last status ${latest.status}) — run aborted`);
            }
            await this.sleep(config.scrape.runPollIntervalMs);
            const res = await this.fetchImpl(`${config.scrape.apifyBaseUrl}/v2/actor-runs/${latest.id}`, {
                headers: { authorization: `Bearer ${this.token}` },
            });
            if (!res.ok) {
                throw new Error(`apify run poll failed: ${res.status} for run ${latest.id}`);
            }
            const record = parseRunRecord(await res.json().catch(() => null));
            if (!record) {
                throw new Error(`apify run poll returned no run record for ${latest.id}`);
            }
            latest = record;
            if (TERMINAL_STATUSES.has(latest.status))
                return latest;
        }
    }
    private async abortRun(runId: string): Promise<void> {
        try {
            await this.fetchImpl(`${config.scrape.apifyBaseUrl}/v2/actor-runs/${runId}/abort`, {
                method: 'POST',
                headers: { authorization: `Bearer ${this.token}` },
            });
            log.warn('aborted a timed-out apify run', { runId });
        }
        catch (err) {
            log.warn('could not abort the timed-out apify run — it may still be billing', {
                runId,
                error: (err as Error).message,
            });
        }
    }
    private async fetchDataset(actor: string, datasetId: string): Promise<unknown[]> {
        const res = await this.fetchImpl(`${config.scrape.apifyBaseUrl}/v2/datasets/${datasetId}/items?clean=true&format=json`, { headers: { authorization: `Bearer ${this.token}` } });
        if (!res.ok) {
            throw new Error(`apify ${actor} dataset ${datasetId} read failed: ${res.status}`);
        }
        const body = await res.json().catch(() => null);
        if (!Array.isArray(body)) {
            throw new Error(`apify ${actor} dataset ${datasetId} did not return an array`);
        }
        return body;
    }
    private async offline(key: string, effectiveMode: RunMode, degradedReason: string | null): Promise<ApifyRunResult> {
        const items = (await readFixture<unknown[]>(key)) ?? [];
        if (items.length === 0 && this.mode === 'replay') {
            log.warn('no fixture for key — treating as a zero-result run', { key });
        }
        return {
            items,
            mode: this.mode,
            effectiveMode,
            costUsd: 0,
            costSource: 'none',
            fixtureKey: key,
            runId: null,
            degradedReason,
        };
    }
}
