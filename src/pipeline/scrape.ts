import { config } from '../../config/index.js';
import { ApifyClient, buildPostsInput, buildReactionsInput } from '../clients/apify.js';
import { assessEngagersPayload, assessPostsPayload, normalizePostId, partitionRunItems, type HarvestActor, type HarvestComment, type HarvestPost, type HarvestReaction, } from './schema/harvest.js';
import { decide, zeroDayVerdict, type BudgetSnapshot } from '../guardrails/spend_governor.js';
import { isInternalProfileId, linkedInSlug, normalizeLinkedInUrl } from '../lib/identity.js';
import { logger } from '../lib/log.js';
import * as repo from '../repo/index.js';
const log = logger('scrape');
export interface ResolvedPost {
    linkedinPostId: string;
    postUrl: string | null;
    authorSlug: string | null;
    authorName: string | null;
    authorHeadline: string | null;
    isRepost: boolean;
    repostedBySlug: string | null;
    contentText: string | null;
    postedAt: Date | null;
}
export function parsePostedAt(raw: unknown): Date | null {
    if (!raw)
        return null;
    if (typeof raw === 'string') {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof raw === 'number') {
        const ms = raw > 1e12 ? raw : raw * 1000;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof raw !== 'object')
        return null;
    const obj = raw as {
        timestamp?: number | null;
        date?: string | null;
    };
    if (typeof obj.timestamp === 'number') {
        const ms = obj.timestamp > 1e12 ? obj.timestamp : obj.timestamp * 1000;
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime()))
            return d;
    }
    if (obj.date) {
        const d = new Date(obj.date);
        if (!Number.isNaN(d.getTime()))
            return d;
    }
    return null;
}
export function postIdFromUrl(url: string | null | undefined): string | null {
    return normalizePostId(url);
}
function actorSlug(actor: HarvestActor | null | undefined): string | null {
    if (!actor)
        return null;
    if (actor.publicIdentifier)
        return actor.publicIdentifier.toLowerCase();
    return linkedInSlug(actor.linkedinUrl) ?? actor.universalName?.toLowerCase() ?? null;
}
function actorHeadline(actor: HarvestActor | null | undefined): string | null {
    if (!actor)
        return null;
    return actor.headline ?? actor.position ?? actor.info ?? null;
}
export function resolvePost(post: HarvestPost, viaSeedSlug: string | null): ResolvedPost | null {
    const id = normalizePostId(post.id) ?? normalizePostId(post.linkedinUrl);
    if (!id)
        return null;
    const isQuote = Boolean(post.repost);
    const isPureRepost = Boolean(post.repostedBy) && !isQuote;
    const repostedBySlug = isPureRepost
        ? (post.repostedBy?.publicIdentifier?.toLowerCase() ??
            linkedInSlug(post.repostedBy?.linkedinUrl) ??
            post.repostedBy?.universalName?.toLowerCase() ??
            viaSeedSlug)
        :
            null;
    return {
        linkedinPostId: id,
        postUrl: post.linkedinUrl ?? null,
        authorSlug: actorSlug(post.author),
        authorName: post.author?.name ?? null,
        authorHeadline: actorHeadline(post.author),
        isRepost: isQuote || isPureRepost,
        repostedBySlug,
        contentText: post.content ?? null,
        postedAt: parsePostedAt(post.postedAt),
    };
}
export const resolveOriginalPost = resolvePost;
export interface NormalizedEngager {
    linkedinUrl: string;
    linkedinSlug: string | null;
    aliasUrls: string[];
    fullName: string | null;
    headline: string | null;
    location: string | null;
    countryClass: 'US' | 'non_US' | 'unknown';
    isCompanyPage: boolean;
    companyName: string | null;
    engagementType: 'like' | 'comment';
    rawReactionType: string | null;
    commentText: string | null;
    postId: string | null;
    occurredAt: Date | null;
    profileJson: unknown;
}
const US_MARKERS = [
    'united states',
    ', usa',
    'washington, district of columbia',
    'greater ',
    ' area',
    ' metropolitan',
];
export function classifyCountry(location: string | null | undefined): 'US' | 'non_US' | 'unknown' {
    if (!location)
        return 'unknown';
    const lower = location.toLowerCase();
    if (lower.includes('united states') || /\busa\b/.test(lower))
        return 'US';
    if (US_MARKERS.some((m) => lower.includes(m)))
        return 'unknown';
    if (lower.split(',').length >= 2)
        return 'non_US';
    return 'unknown';
}
export function classifyActorCountry(actor: HarvestActor | null | undefined, locationText: string | null): 'US' | 'non_US' | 'unknown' {
    const loc = actor?.location;
    if (loc && typeof loc === 'object') {
        const code = loc.countryCode ?? loc.parsed?.countryCode ?? null;
        if (code)
            return code.toUpperCase() === 'US' ? 'US' : 'non_US';
    }
    return classifyCountry(locationText);
}
export function locationTextOf(actor: HarvestActor | null | undefined): string | null {
    const loc = actor?.location;
    if (!loc)
        return null;
    if (typeof loc === 'string')
        return loc;
    return loc.linkedinText ?? loc.parsed?.text ?? null;
}
export function companyFromHeadline(headline: string | null | undefined): string | null {
    if (!headline)
        return null;
    const at = /\b(?:at|@)\s+([A-Z][\w&.,'’-]*(?:\s+[A-Z][\w&.,'’-]*){0,3})/.exec(headline);
    if (at?.[1])
        return at[1].replace(/[,.]$/, '').trim();
    const comma = /^(?:co-?)?(?:founder|ceo|cto|coo|president|principal|partner)\s*(?:&\s*\w+\s*)?,\s+([^|]+)/i.exec(headline);
    if (comma?.[1])
        return comma[1].split('|')[0]!.trim();
    const ofPattern = /\b(?:founder|ceo|president)\s+of\s+([A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,2})/i.exec(headline);
    return ofPattern?.[1]?.trim() ?? null;
}
export function companyFromActor(actor: HarvestActor | null | undefined): string | null {
    const current = (actor?.experience ?? []).find((e) => {
        const end = (e as {
            endDate?: {
                text?: string | null;
            } | null;
        }).endDate;
        return !end || (end.text ?? '').toLowerCase() === 'present';
    });
    const fromExperience = (current as {
        companyName?: string | null;
    } | undefined)?.companyName;
    if (fromExperience)
        return fromExperience;
    return companyFromHeadline(actorHeadline(actor));
}
export interface ActorIdentity {
    canonicalUrl: string;
    slug: string | null;
    aliasUrls: string[];
}
export function actorIdentity(actor: HarvestActor | null | undefined): ActorIdentity | null {
    if (!actor)
        return null;
    const seenUrl = normalizeLinkedInUrl(actor.linkedinUrl);
    const seenSlug = seenUrl ? linkedInSlug(seenUrl) : null;
    const publicSlug = actor.publicIdentifier?.trim().toLowerCase() || null;
    const fromPublic = publicSlug
        ? normalizeLinkedInUrl(`https://www.linkedin.com/in/${publicSlug}`)
        : null;
    if (seenUrl && !seenUrl.includes('/in/')) {
        return { canonicalUrl: seenUrl, slug: seenSlug, aliasUrls: [] };
    }
    const internalUrl = isInternalProfileId(actor.id)
        ? normalizeLinkedInUrl(`https://www.linkedin.com/in/${actor.id}`)
        : null;
    const canonicalUrl = fromPublic && !isInternalProfileId(publicSlug)
        ? fromPublic
        : seenUrl && !isInternalProfileId(seenSlug)
            ? seenUrl
            : (fromPublic ?? seenUrl ?? internalUrl);
    if (!canonicalUrl)
        return null;
    const aliasUrls = [seenUrl, fromPublic, internalUrl].filter((u): u is string => Boolean(u) && u !== canonicalUrl);
    return { canonicalUrl, slug: linkedInSlug(canonicalUrl), aliasUrls: [...new Set(aliasUrls)] };
}
function normalizeActor(actor: HarvestActor | null | undefined, engagementType: 'like' | 'comment', rawReactionType: string | null, commentText: string | null, postId: string | null, occurredAt: Date | null): NormalizedEngager | null {
    const identity = actorIdentity(actor);
    if (!identity || !actor)
        return null;
    const headline = actorHeadline(actor);
    const loc = locationTextOf(actor);
    return {
        linkedinUrl: identity.canonicalUrl,
        linkedinSlug: identity.slug,
        aliasUrls: identity.aliasUrls,
        fullName: actor.name ?? null,
        headline,
        location: loc,
        countryClass: classifyActorCountry(actor, loc),
        isCompanyPage: identity.canonicalUrl.includes('/company/') ||
            identity.canonicalUrl.includes('/showcase/') ||
            (actor.type ?? '').toLowerCase() === 'company' ||
            Boolean(actor.pageType),
        companyName: companyFromActor(actor),
        engagementType,
        rawReactionType,
        commentText,
        postId,
        occurredAt,
        profileJson: actor,
    };
}
function engagerFromReaction(reaction: HarvestReaction, fallbackPostId: string | null): NormalizedEngager | null {
    return normalizeActor(reaction.actor, 'like', reaction.reactionType ?? null, null, normalizePostId(reaction.postId) ?? fallbackPostId, null);
}
function engagerFromComment(comment: HarvestComment, fallbackPostId: string | null): NormalizedEngager | null {
    return normalizeActor(comment.actor, 'comment', 'COMMENT', comment.commentary ?? null, normalizePostId(comment.postId) ?? fallbackPostId, parsePostedAt(comment.createdAtTimestamp ?? comment.createdAt));
}
export function collectEngagers(items: unknown[]): NormalizedEngager[] {
    const split = partitionRunItems(items);
    const out: NormalizedEngager[] = [];
    const seen = new Set<string>();
    const push = (engager: NormalizedEngager | null): void => {
        if (!engager)
            return;
        const key = `${engager.postId ?? '-'}|${engager.linkedinUrl}|${engager.engagementType}`;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push(engager);
    };
    for (const post of split.posts) {
        const postId = normalizePostId(post.id) ?? normalizePostId(post.linkedinUrl);
        for (const reaction of post.reactions ?? [])
            push(engagerFromReaction(reaction, postId));
        for (const comment of post.comments ?? []) {
            push(engagerFromComment(comment, postId));
            for (const reply of comment.replies ?? []) {
                push(engagerFromComment(reply as HarvestComment, postId));
            }
        }
    }
    for (const reaction of split.reactions)
        push(engagerFromReaction(reaction, null));
    for (const comment of split.comments) {
        push(engagerFromComment(comment, null));
        for (const reply of comment.replies ?? []) {
            push(engagerFromComment(reply as HarvestComment, normalizePostId(comment.postId)));
        }
    }
    return out;
}
export function normalizeEngagers(post: HarvestPost): NormalizedEngager[] {
    return collectEngagers([post]);
}
export function isHotSignal(engager: NormalizedEngager): boolean {
    return engager.engagementType === 'comment';
}
export function stageBPlan(postedAt: Date | null, lastScrapedAt: Date | null, now: Date): {
    due: boolean;
    retire: boolean;
    ageHours: number | null;
    reason: string;
} {
    if (!postedAt) {
        const since = lastScrapedAt ? (now.getTime() - lastScrapedAt.getTime()) / 60000 : null;
        const due = since === null || since >= config.scrape.cadenceMinutes.engagersTail;
        return { due, retire: false, ageHours: null, reason: due ? 'undated' : 'undated_too_soon' };
    }
    const ageHours = (now.getTime() - postedAt.getTime()) / 3600000;
    const retireAfterHours = config.scrape.retireAfterDays * 24;
    if (ageHours >= retireAfterHours) {
        return { due: true, retire: true, ageHours, reason: 'retirement_snapshot' };
    }
    const interval = ageHours < 24
        ? config.scrape.cadenceMinutes.engagersFresh
        : config.scrape.cadenceMinutes.engagersTail;
    const since = lastScrapedAt ? (now.getTime() - lastScrapedAt.getTime()) / 60000 : null;
    const due = since === null || since >= interval;
    return {
        due,
        retire: false,
        ageHours,
        reason: due ? (ageHours < 24 ? 'fresh' : 'tail') : 'too_soon',
    };
}
export interface ScrapeSummary {
    seedsPolled: number;
    postsSeen: number;
    postsNew: number;
    postsPolled: number;
    engagersSeen: number;
    prospectsNew: number;
    engagementsNew: number;
    costUsd: number;
    drifted: string[];
    zeroFlagged: string[];
    skipped: Array<{
        target: string;
        reason: string;
    }>;
}
export interface ScrapeDeps {
    apify: ApifyClient;
    now: () => Date;
}
export function emptySummary(): ScrapeSummary {
    return {
        seedsPolled: 0,
        postsSeen: 0,
        postsNew: 0,
        postsPolled: 0,
        engagersSeen: 0,
        prospectsNew: 0,
        engagementsNew: 0,
        costUsd: 0,
        drifted: [],
        zeroFlagged: [],
        skipped: [],
    };
}
export type EngagerStore = Pick<typeof repo, 'upsertProspect' | 'insertEngagement'>;
export async function persistEngager(engager: NormalizedEngager, postId: number, window: {
    start: Date;
    end: Date;
}, summary: ScrapeSummary, store: EngagerStore = repo): Promise<void> {
    summary.engagersSeen += 1;
    const { id: prospectId, created } = await store.upsertProspect({
        linkedinUrl: engager.linkedinUrl,
        linkedinSlug: engager.linkedinSlug,
        fullName: engager.fullName,
        headline: engager.headline,
        location: engager.location,
        countryClass: engager.countryClass,
        isCompanyPage: engager.isCompanyPage,
        companyName: engager.companyName,
        profileJson: engager.profileJson,
        aliasUrls: engager.aliasUrls,
    });
    if (created)
        summary.prospectsNew += 1;
    const inserted = await store.insertEngagement({
        postId,
        prospectId,
        engagementType: engager.engagementType,
        rawReactionType: engager.rawReactionType,
        commentText: engager.commentText,
        scrapeWindowStart: window.start,
        scrapeWindowEnd: window.end,
        occurredAt: engager.occurredAt,
    });
    if (inserted)
        summary.engagementsNew += 1;
}
export async function runScrape(deps: ScrapeDeps = { apify: new ApifyClient(), now: () => new Date() }): Promise<ScrapeSummary> {
    const summary = emptySummary();
    if (deps.apify.runMode !== 'live' && !config.scrape.allowOfflineWrites) {
        log.warn('offline scrape mode — nothing written', {
            mode: deps.apify.runMode,
            hint: 'set GROWTH_SCRAPE_MODE=live (with APIFY_TOKEN) or GROWTH_ALLOW_OFFLINE_SCRAPE_WRITES=true for a local walkthrough',
        });
        summary.skipped.push({ target: '*', reason: `offline scrape mode (${deps.apify.runMode}) — writes disabled` });
        return summary;
    }
    const spentToday = await repo.spendToday('apify', deps.now());
    const budget: BudgetSnapshot = {
        spentTodayUsd: spentToday,
        capUsd: config.scrape.dailySpendCapUsd,
    };
    await runStageA(deps, summary, budget);
    await runStageB(deps, summary, budget);
    return summary;
}
async function runStageA(deps: ScrapeDeps, summary: ScrapeSummary, budget: BudgetSnapshot): Promise<void> {
    const seeds = await repo.listTrackedSeeds();
    for (const seed of seeds) {
        const minutesSince = seed.last_scraped_at
            ? (deps.now().getTime() - seed.last_scraped_at.getTime()) / 60000
            : null;
        const decision = decide({
            kind: seed.kind === 'company' ? 'company_posts' : 'posts',
            estimatedResults: config.scrape.maxPosts,
            postAgeHours: null,
            minutesSinceLastScrape: minutesSince,
            cadenceClass: seed.cadence_class,
        }, budget);
        if (!decision.proceed) {
            summary.skipped.push({ target: seed.slug, reason: decision.reason });
            continue;
        }
        await scrapeSeedViaHarvest(seed, deps, summary, budget);
    }
}
export async function scrapeSeedViaHarvest(seed: repo.SeedAccountRow, deps: ScrapeDeps, summary: ScrapeSummary, budget: BudgetSnapshot): Promise<void> {
    const actorName = seed.kind === 'company' ? config.scrape.actors.companyPosts : config.scrape.actors.profilePosts;
    const kind = seed.kind === 'company' ? ('company_posts' as const) : ('posts' as const);
    try {
        const input = buildPostsInput({
            targetUrls: [seed.linkedin_url],
            postedLimit: seed.last_scraped_at
                ? config.scrape.postedWindow
                : config.scrape.firstPollWindow,
        });
        const run = seed.kind === 'company'
            ? await deps.apify.runCompanyPosts(input)
            : await deps.apify.runProfilePosts(input);
        summary.seedsPolled += 1;
        summary.costUsd += run.costUsd;
        budget.spentTodayUsd += run.costUsd;
        await repo.recordSpend('apify', run.costUsd, run.items.length, { seed: seed.slug });
        const verdict = assessPostsPayload(run.items);
        if (verdict.kind === 'drift') {
            summary.drifted.push(seed.slug);
            await repo.openHold({
                subjectKind: 'seed_account',
                subjectId: seed.id,
                stage: 'scrape',
                reason: 'actor schema drift',
                detail: verdict,
            });
            await repo.recordScrapeRun({
                seedAccountId: seed.id,
                postId: null,
                kind,
                actor: actorName,
                mode: deps.apify.runMode,
                resultsCount: verdict.total,
                newCount: 0,
                costUsd: run.costUsd,
                outcome: 'schema_drift',
                error: verdict.note,
            });
            return;
        }
        const split = partitionRunItems(run.items);
        const engagers = collectEngagers(run.items);
        const byPost = new Map<string, NormalizedEngager[]>();
        for (const engager of engagers) {
            if (!engager.postId)
                continue;
            const list = byPost.get(engager.postId) ?? [];
            list.push(engager);
            byPost.set(engager.postId, list);
        }
        const windowEnd = deps.now();
        const windowStart = seed.last_scraped_at ?? windowEnd;
        let engagersThisSeed = 0;
        let postsNewThisSeed = 0;
        for (const item of split.posts) {
            const resolved = resolvePost(item, seed.slug);
            if (!resolved)
                continue;
            summary.postsSeen += 1;
            const { id: postId, created } = await repo.upsertPost({
                ...resolved,
                discoveredViaSeedId: seed.id,
            });
            if (created) {
                summary.postsNew += 1;
                postsNewThisSeed += 1;
            }
            const postEngagers = byPost.get(resolved.linkedinPostId) ?? [];
            for (const engager of postEngagers) {
                engagersThisSeed += 1;
                await persistEngager(engager, postId, { start: windowStart, end: windowEnd }, summary);
            }
        }
        const alive = engagersThisSeed > 0 || split.posts.length > 0;
        const zero = zeroDayVerdict(seed.consecutive_zero_days, alive);
        await repo.recordZeroDay(seed.id, zero.consecutiveZeroDays, alive);
        if (zero.flagged)
            summary.zeroFlagged.push(seed.slug);
        await repo.recordScrapeRun({
            seedAccountId: seed.id,
            postId: null,
            kind,
            actor: actorName,
            mode: deps.apify.runMode,
            resultsCount: run.items.length,
            newCount: postsNewThisSeed,
            costUsd: run.costUsd,
            outcome: alive ? 'ok' : 'zero',
            error: null,
        });
    }
    catch (err) {
        log.error('seed scrape failed', { seed: seed.slug, error: (err as Error).message });
        await repo.openHold({
            subjectKind: 'seed_account',
            subjectId: seed.id,
            stage: 'scrape',
            reason: 'actor error',
            detail: { message: (err as Error).message },
        });
        await repo.recordScrapeRun({
            seedAccountId: seed.id,
            postId: null,
            kind,
            actor: actorName,
            mode: deps.apify.runMode,
            resultsCount: 0,
            newCount: 0,
            costUsd: 0,
            outcome: 'actor_error',
            error: (err as Error).message,
        });
    }
}
async function runStageB(deps: ScrapeDeps, summary: ScrapeSummary, budget: BudgetSnapshot): Promise<void> {
    const posts = (await repo.listPollablePosts()).slice(0, config.scrape.maxPostsPerTick);
    let pulled = 0;
    for (const post of posts) {
        const now = deps.now();
        const plan = stageBPlan(post.posted_at, post.last_scraped_at, now);
        if (!plan.due) {
            summary.skipped.push({ target: post.linkedin_post_id, reason: plan.reason });
            continue;
        }
        if (!post.post_url) {
            if (plan.retire) {
                await repo.markPostScraped(post.id, 0, { retirementSnapshot: true, retire: true });
            }
            summary.skipped.push({ target: post.linkedin_post_id, reason: 'no_post_url' });
            continue;
        }
        if (!plan.retire) {
            const decision = decide({
                kind: 'engagers',
                estimatedResults: config.scrape.maxReactionsPerPost,
                postAgeHours: plan.ageHours,
                minutesSinceLastScrape: post.last_scraped_at
                    ? (now.getTime() - post.last_scraped_at.getTime()) / 60000
                    : null,
            }, budget);
            if (!decision.proceed) {
                summary.skipped.push({ target: post.linkedin_post_id, reason: decision.reason });
                continue;
            }
        }
        try {
            const run = await deps.apify.runPostReactions(buildReactionsInput({ postUrls: [post.post_url], profileScraperMode: 'main' }));
            summary.postsPolled += 1;
            pulled += 1;
            summary.costUsd += run.costUsd;
            budget.spentTodayUsd += run.costUsd;
            await repo.recordSpend('apify', run.costUsd, run.items.length, {
                post: post.linkedin_post_id,
                kind: plan.retire ? 'retirement_snapshot' : 'engagers',
            });
            const verdict = assessEngagersPayload(run.items);
            if (verdict.kind === 'drift') {
                summary.drifted.push(post.linkedin_post_id);
                await repo.openHold({
                    subjectKind: 'post',
                    subjectId: post.id,
                    stage: 'scrape',
                    reason: 'reaction payload drift',
                    detail: verdict,
                });
                await repo.recordScrapeRun({
                    seedAccountId: null,
                    postId: post.id,
                    kind: plan.retire ? 'retirement_snapshot' : 'engagers',
                    actor: config.scrape.actors.postReactions,
                    mode: deps.apify.runMode,
                    resultsCount: verdict.total,
                    newCount: 0,
                    costUsd: run.costUsd,
                    outcome: 'schema_drift',
                    error: verdict.note,
                });
                continue;
            }
            const engagers = collectEngagers(run.items);
            const before = summary.engagementsNew;
            const windowEnd = deps.now();
            const windowStart = post.last_scraped_at ?? windowEnd;
            for (const engager of engagers) {
                await persistEngager(engager, post.id, { start: windowStart, end: windowEnd }, summary);
            }
            const newHere = summary.engagementsNew - before;
            await repo.recordScrapeRun({
                seedAccountId: null,
                postId: post.id,
                kind: plan.retire ? 'retirement_snapshot' : 'engagers',
                actor: config.scrape.actors.postReactions,
                mode: deps.apify.runMode,
                resultsCount: run.items.length,
                newCount: newHere,
                costUsd: run.costUsd,
                outcome: engagers.length > 0 ? 'ok' : 'zero',
                error: null,
            });
            await repo.markPostScraped(post.id, engagers.length, {
                retirementSnapshot: plan.retire,
                retire: plan.retire,
            });
        }
        catch (err) {
            log.error('engager pull failed', {
                post: post.linkedin_post_id,
                error: (err as Error).message,
            });
            await repo.openHold({
                subjectKind: 'post',
                subjectId: post.id,
                stage: 'scrape',
                reason: plan.retire ? 'retirement snapshot failed' : 'actor error',
                detail: { message: (err as Error).message },
            });
            await repo.recordScrapeRun({
                seedAccountId: null,
                postId: post.id,
                kind: plan.retire ? 'retirement_snapshot' : 'engagers',
                actor: config.scrape.actors.postReactions,
                mode: deps.apify.runMode,
                resultsCount: 0,
                newCount: 0,
                costUsd: 0,
                outcome: 'actor_error',
                error: (err as Error).message,
            });
        }
    }
    if (pulled >= config.scrape.maxPostsPerTick) {
        log.info('stage B hit the per-tick cap; the remainder rolls to the next tick', {
            pulled,
            cap: config.scrape.maxPostsPerTick,
        });
    }
}
