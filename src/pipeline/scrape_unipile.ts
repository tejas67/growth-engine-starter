import { config } from '../../config/index.js';
import { productionUnipileLedger } from '../clients/unipile_ledger.js';
import { ApifyClient } from '../clients/apify.js';
import { DailyCallBudget, UnipileBudgetExhausted, UnipileClient, UnipileError, type UnipileCallKind, type UnipileCallLedger, } from '../clients/unipile.js';
import { decide, zeroDayVerdict, type BudgetSnapshot } from '../guardrails/spend_governor.js';
import { logger } from '../lib/log.js';
import * as repo from '../repo/index.js';
import { collectEngagers, emptySummary, persistEngager, resolvePost, scrapeSeedViaHarvest, stageBPlan, type ScrapeSummary, } from './scrape.js';
import { assessEngagersPayload, assessPostsPayload, partitionRunItems } from './schema/harvest.js';
import { mapEngagersPage, mapPostsPage, socialIdFor } from './schema/unipile.js';
const log = logger('scrape-unipile');
export const UNIPILE_ACTORS = {
    posts: 'unipile/users.posts',
    companyPosts: 'unipile/users.posts?is_company',
    engagers: 'unipile/posts.reactions+comments',
} as const;
export type UnipileScrapeStore = Pick<typeof repo, 'listTrackedSeeds' | 'setSeedProviderId' | 'upsertPost' | 'upsertProspect' | 'insertEngagement' | 'recordZeroDay' | 'recordScrapeRun' | 'recordSpend' | 'unitsToday' | 'listPollablePosts' | 'markPostScraped' | 'saveUnipilePollState' | 'openHold'>;
export interface UnipileScrapeSummary extends ScrapeSummary {
    source: 'unipile';
    calls: number;
    profileCalls: number;
    seedsResolved: number;
    harvestFallbacks: number;
    stopped: string | null;
}
export interface UnipileScrapeDeps {
    makeClient?: (ledger: UnipileCallLedger) => UnipileClient;
    apify?: ApifyClient;
    harvestFallback?: (seed: repo.SeedAccountRow, summary: ScrapeSummary) => Promise<void>;
    store?: UnipileScrapeStore;
    now?: () => Date;
}
export function ledgerCategory(kind: UnipileCallKind): 'unipile' | 'unipile_profile' | null {
    switch (kind) {
        case 'posts':
        case 'reactions':
        case 'comments':
            return 'unipile';
        case 'profile':
        case 'company':
            return 'unipile_profile';
        case 'accounts':
            return null;
    }
}
function summaryFor(): UnipileScrapeSummary {
    return {
        ...emptySummary(),
        source: 'unipile',
        calls: 0,
        profileCalls: 0,
        seedsResolved: 0,
        harvestFallbacks: 0,
        stopped: null,
    };
}
const UNBOUNDED_DOLLARS: BudgetSnapshot = { spentTodayUsd: 0, capUsd: Number.POSITIVE_INFINITY };
export function stopReasonFor(err: unknown): string | null {
    if (err instanceof UnipileBudgetExhausted)
        return err.reason;
    if (err instanceof UnipileError && err.retryable) {
        const wait = err.retryAfterMs ? ` (retry-after ${Math.round(err.retryAfterMs / 1000)}s)` : '';
        return `LinkedIn/Unipile answered HTTP ${err.status}${wait} — stopping this tick rather than retrying`;
    }
    if (err instanceof UnipileError && (err.status === 401 || err.status === 403)) {
        return `Unipile rejected the credential (HTTP ${err.status}) — check UNIPILE_API_KEY / UNIPILE_ACCOUNT_ID`;
    }
    return null;
}
export async function runUnipileScrape(deps: UnipileScrapeDeps = {}): Promise<UnipileScrapeSummary> {
    const store = deps.store ?? repo;
    const now = deps.now ?? (() => new Date());
    const summary = summaryFor();
    const budget = new DailyCallBudget({
        callsUsed: await store.unitsToday('unipile', now()),
        callCap: config.unipile.dailyCallCap,
        profilesUsed: await store.unitsToday('unipile_profile', now()),
        profileCap: config.unipile.dailyProfileCap,
    }, async (kind) => {
        const category = ledgerCategory(kind);
        if (!category)
            return;
        if (category === 'unipile')
            summary.calls += 1;
        else
            summary.profileCalls += 1;
        await store.recordSpend(category, 0, 1, { kind });
    });
    const ledger = deps.store ? budget : productionUnipileLedger(async (kind) => {
        const category = ledgerCategory(kind);
        if (category === 'unipile')
            summary.calls += 1;
        if (category === 'unipile_profile')
            summary.profileCalls += 1;
    });
    const client = (deps.makeClient ?? ((ledger) => new UnipileClient(undefined, undefined, { ledger })))(ledger);
    if (client.runMode !== 'live' && !config.scrape.allowOfflineWrites) {
        log.warn('offline scrape mode — nothing written', {
            source: 'unipile',
            mode: client.runMode,
            hint: 'set GROWTH_UNIPILE_MODE=live (with UNIPILE_DSN/UNIPILE_API_KEY/UNIPILE_ACCOUNT_ID) or GROWTH_ALLOW_OFFLINE_SCRAPE_WRITES=true for a local walkthrough',
        });
        summary.skipped.push({ target: '*', reason: `offline scrape mode (${client.runMode}) — writes disabled` });
        return summary;
    }
    if (client.degraded) {
        const missing = client.missingCredential;
        log.warn('DEGRADED: unipile is live but a credential is missing — nothing polled, nothing written', {
            missing,
        });
        summary.skipped.push({ target: '*', reason: `${missing} absent — no live call was made` });
        return summary;
    }
    const harvestFallback = deps.harvestFallback ??
        (async (seed: repo.SeedAccountRow, s: ScrapeSummary) => {
            const apify = deps.apify ?? new ApifyClient();
            if (apify.runMode !== 'live' || apify.degraded) {
                s.skipped.push({
                    target: seed.slug,
                    reason: 'company seed stays on HarvestAPI (GROWTH_UNIPILE_COMPANY_SEEDS=harvestapi) but the Apify client is not live',
                });
                return;
            }
            const spent = await repo.spendToday('apify', now());
            await scrapeSeedViaHarvest(seed, { apify, now }, s, {
                spentTodayUsd: spent,
                capUsd: config.scrape.dailySpendCapUsd,
            });
        });
    const accountStopped = await runStageA(client, store, now, summary, harvestFallback);
    if (accountStopped) {
        log.warn('stage B skipped — the tick already stopped', { reason: summary.stopped });
        return summary;
    }
    await runStageB(client, store, now, summary);
    return summary;
}
async function providerIdFor(seed: repo.SeedAccountRow, client: UnipileClient, store: UnipileScrapeStore, summary: UnipileScrapeSummary): Promise<string | null> {
    if (seed.unipile_provider_id)
        return seed.unipile_provider_id;
    let id: string | null;
    let degradedReason: string | null;
    if (seed.kind === 'company') {
        const read = await client.getCompany(seed.slug);
        id = read.data?.id ?? null;
        degradedReason = read.degradedReason;
    }
    else {
        const read = await client.getUser(seed.slug);
        id = read.data?.providerId ?? null;
        degradedReason = read.degradedReason;
    }
    if (!id) {
        summary.skipped.push({ target: seed.slug, reason: degradedReason ?? 'provider id not returned' });
        return null;
    }
    await store.setSeedProviderId(seed.id, id);
    summary.seedsResolved += 1;
    return id;
}
async function runStageA(client: UnipileClient, store: UnipileScrapeStore, now: () => Date, summary: UnipileScrapeSummary, harvestFallback: (seed: repo.SeedAccountRow, summary: ScrapeSummary) => Promise<void>): Promise<boolean> {
    const seeds = await store.listTrackedSeeds();
    for (const seed of seeds) {
        const minutesSince = seed.last_scraped_at
            ? (now().getTime() - seed.last_scraped_at.getTime()) / 60000
            : null;
        const kind = seed.kind === 'company' ? ('company_posts' as const) : ('posts' as const);
        const decision = decide({
            kind,
            estimatedResults: config.unipile.postsPerSeed,
            postAgeHours: null,
            minutesSinceLastScrape: minutesSince,
            cadenceClass: seed.cadence_class,
        }, UNBOUNDED_DOLLARS);
        if (!decision.proceed) {
            summary.skipped.push({ target: seed.slug, reason: decision.reason });
            continue;
        }
        if (seed.kind === 'company' && config.unipile.companySeeds === 'harvestapi') {
            summary.harvestFallbacks += 1;
            await harvestFallback(seed, summary);
            continue;
        }
        const actorName = seed.kind === 'company' ? UNIPILE_ACTORS.companyPosts : UNIPILE_ACTORS.posts;
        try {
            const providerId = await providerIdFor(seed, client, store, summary);
            if (!providerId)
                continue;
            const read = await client.listPosts(providerId, {
                isCompany: seed.kind === 'company',
                limit: config.unipile.postsPerSeed,
            });
            summary.seedsPolled += 1;
            const mapped = mapPostsPage(read.data, { now: now(), seedSlug: seed.slug });
            const verdict = assessPostsPayload(mapped);
            if (verdict.kind === 'drift') {
                summary.drifted.push(seed.slug);
                await store.openHold({
                    subjectKind: 'seed_account',
                    subjectId: seed.id,
                    stage: 'scrape',
                    reason: 'source schema drift',
                    detail: verdict,
                });
                await store.recordScrapeRun({
                    seedAccountId: seed.id,
                    postId: null,
                    kind,
                    actor: actorName,
                    mode: read.effectiveMode,
                    resultsCount: verdict.total,
                    newCount: 0,
                    costUsd: 0,
                    outcome: 'schema_drift',
                    error: verdict.note,
                });
                continue;
            }
            const split = partitionRunItems(mapped);
            let postsNewThisSeed = 0;
            for (const item of split.posts) {
                const resolved = resolvePost(item, seed.slug);
                if (!resolved)
                    continue;
                summary.postsSeen += 1;
                const original = read.data.find(raw => raw && typeof raw === 'object' &&
                    String((raw as {
                        id?: unknown;
                    }).id) === resolved.linkedinPostId) as {
                    social_id?: string;
                } | undefined;
                const { created } = await store.upsertPost({ ...resolved, discoveredViaSeedId: seed.id,
                    unipileSocialId: original?.social_id ?? null });
                if (created) {
                    summary.postsNew += 1;
                    postsNewThisSeed += 1;
                }
            }
            const alive = split.posts.length > 0;
            const zero = zeroDayVerdict(seed.consecutive_zero_days, alive);
            await store.recordZeroDay(seed.id, zero.consecutiveZeroDays, alive);
            if (zero.flagged)
                summary.zeroFlagged.push(seed.slug);
            await store.recordScrapeRun({
                seedAccountId: seed.id,
                postId: null,
                kind,
                actor: actorName,
                mode: read.effectiveMode,
                resultsCount: read.data.length,
                newCount: postsNewThisSeed,
                costUsd: 0,
                outcome: alive ? 'ok' : 'zero',
                error: null,
            });
        }
        catch (err) {
            const stop = stopReasonFor(err);
            if (stop) {
                log.error('stage A stopped', { seed: seed.slug, reason: stop });
                summary.stopped = stop;
                summary.skipped.push({ target: seed.slug, reason: stop });
                await store.recordScrapeRun({
                    seedAccountId: seed.id,
                    postId: null,
                    kind,
                    actor: actorName,
                    mode: 'live',
                    resultsCount: 0,
                    newCount: 0,
                    costUsd: 0,
                    outcome: err instanceof UnipileBudgetExhausted ? 'budget_skipped' : 'rate_limited',
                    error: stop,
                });
                return !(err instanceof UnipileBudgetExhausted);
            }
            if (err instanceof UnipileError && err.notFound) {
                const reason = seed.kind === 'company'
                    ? 'company not found on Unipile (404) — verify the company slug'
                    : 'seed not found on LinkedIn (404) — verify the slug';
                log.error('seed not found', { seed: seed.slug, kind: seed.kind });
                await store.openHold({
                    subjectKind: 'seed_account',
                    subjectId: seed.id,
                    stage: 'scrape',
                    reason,
                    detail: { message: (err as Error).message },
                });
                await store.recordScrapeRun({
                    seedAccountId: seed.id,
                    postId: null,
                    kind,
                    actor: actorName,
                    mode: 'live',
                    resultsCount: 0,
                    newCount: 0,
                    costUsd: 0,
                    outcome: 'actor_error',
                    error: (err as Error).message,
                });
                continue;
            }
            log.error('seed scrape failed', { seed: seed.slug, error: (err as Error).message });
            await store.openHold({
                subjectKind: 'seed_account',
                subjectId: seed.id,
                stage: 'scrape',
                reason: 'source error',
                detail: { message: (err as Error).message },
            });
            await store.recordScrapeRun({
                seedAccountId: seed.id,
                postId: null,
                kind,
                actor: actorName,
                mode: 'live',
                resultsCount: 0,
                newCount: 0,
                costUsd: 0,
                outcome: 'actor_error',
                error: (err as Error).message,
            });
        }
    }
    return false;
}
async function runStageB(client: UnipileClient, store: UnipileScrapeStore, now: () => Date, summary: UnipileScrapeSummary): Promise<void> {
    const all = await store.listPollablePosts();
    const posts = all.filter(p => p.unipile_poll_state?.started_at || stageBPlan(p.posted_at, p.last_scraped_at, now()).due)
        .sort((a, b) => Number((b.posted_at?.getTime() ?? 0) > now().getTime() - 86400000) -
        Number((a.posted_at?.getTime() ?? 0) > now().getTime() - 86400000))
        .slice(0, config.scrape.maxPostsPerTick);
    const blockedActions = new Set<'comments' | 'reactions'>();
    for (const post of posts) {
        const plan = stageBPlan(post.posted_at, post.last_scraped_at, now());
        const kind = plan.retire ? 'retirement_snapshot' as const : 'engagers' as const;
        const socialId = socialIdFor(post.linkedin_post_id, post.unipile_social_id);
        const state: repo.UnipilePollState = { ...post.unipile_poll_state };
        state.started_at ??= now().toISOString();
        try {
            for (const action of ['comments', 'reactions'] as const) {
                if (blockedActions.has(action))
                    continue;
                let progress = state[action] ?? { cursor: null, complete: false };
                let pages = 0;
                const max = action === 'comments' ? config.scrape.maxComments : config.scrape.maxReactionsPerPost;
                const cursors = new Set<string>();
                const pageCap = Math.max(1, Math.ceil(max / config.unipile.pageSize));
                while (!progress.complete && pages < pageCap) {
                    let page;
                    try {
                        page = await client.listEngagerPage(action, socialId, progress.cursor);
                    }
                    catch (err) {
                        if (!(err instanceof UnipileBudgetExhausted))
                            throw err;
                        blockedActions.add(action);
                        summary.stopped = err.reason;
                        summary.skipped.push({ target: action, reason: err.reason });
                        break;
                    }
                    if (page.cursor && (page.cursor === progress.cursor || cursors.has(page.cursor))) {
                        throw new Error('Unipile repeated pagination cursor');
                    }
                    if (page.cursor)
                        cursors.add(page.cursor);
                    const items = mapEngagersPage(action === 'reactions' ? page.items : [], action === 'comments' ? page.items : [], post.linkedin_post_id);
                    const verdict = assessEngagersPayload(items);
                    if (verdict.kind === 'drift')
                        throw new Error(`Unipile engager payload drift: ${verdict.note}`);
                    const before = summary.engagementsNew;
                    for (const engager of collectEngagers(items)) {
                        await persistEngager(engager, post.id, { start: post.last_scraped_at ?? new Date(state.started_at), end: now() }, summary, store);
                    }
                    pages += 1;
                    state.results = (state.results ?? 0) + page.items.length;
                    state.new_count = (state.new_count ?? 0) + summary.engagementsNew - before;
                    progress = { cursor: page.cursor, complete: !page.cursor };
                    state[action] = progress;
                    await store.saveUnipilePollState(post.id, state);
                }
            }
            if (!state.comments?.complete || !state.reactions?.complete) {
                summary.skipped.push({ target: post.linkedin_post_id, reason: 'partial poll saved; next tick resumes its cursor' });
                if (blockedActions.size === 2)
                    return;
                continue;
            }
            await store.recordScrapeRun({ seedAccountId: null, postId: post.id, kind,
                actor: UNIPILE_ACTORS.engagers, mode: 'live', resultsCount: state.results ?? 0,
                newCount: state.new_count ?? 0, costUsd: 0, outcome: state.results ? 'ok' : 'zero', error: null });
            await store.markPostScraped(post.id, state.results ?? 0, { retirementSnapshot: plan.retire, retire: plan.retire, clearUnipileState: true });
            summary.postsPolled += 1;
        }
        catch (err) {
            const stop = stopReasonFor(err);
            await store.recordScrapeRun({ seedAccountId: null, postId: post.id, kind,
                actor: UNIPILE_ACTORS.engagers, mode: 'live', resultsCount: 0, newCount: 0, costUsd: 0,
                outcome: stop ? 'budget_skipped' : 'actor_error', error: (err as Error).message });
            if (stop) {
                summary.stopped = stop;
                return;
            }
            await store.openHold({ subjectKind: 'post', subjectId: post.id, stage: 'scrape',
                reason: 'Unipile source error', detail: { message: (err as Error).message } });
        }
    }
}
