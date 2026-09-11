import { config } from '../../config/index.js';
import { productionUnipileLedger } from '../clients/unipile_ledger.js';
import { DailyCallBudget, UnipileClient, UnipileError, type UnipileCallLedger, type UnipileProfile, } from '../clients/unipile.js';
import { isInternalProfileId, isInternalProfileUrl, linkedInSlug, normalizeLinkedInUrl } from '../lib/identity.js';
import { logger } from '../lib/log.js';
import * as repo from '../repo/index.js';
import { classifyCountry } from './scrape.js';
import { stopReasonFor } from './scrape_unipile.js';
const log = logger('resolve');
export type ResolveStore = Pick<typeof repo, 'listResolveCandidates' | 'upsertProspect' | 'recordResolveOutcome' | 'recordSpend' | 'unitsToday' | 'openHold'>;
export interface ResolveDeps {
    makeClient?: (ledger: UnipileCallLedger) => UnipileClient;
    store?: ResolveStore;
    now?: () => Date;
}
export interface ResolveSummary {
    available: boolean;
    reason: string;
    attempted: number;
    resolved: number;
    notFound: number;
    noSlug: number;
    failures: number;
    profileCalls: number;
    stopped: string | null;
}
function summaryFor(available: boolean, reason: string): ResolveSummary {
    return {
        available,
        reason,
        attempted: 0,
        resolved: 0,
        notFound: 0,
        noSlug: 0,
        failures: 0,
        profileCalls: 0,
        stopped: null,
    };
}
export interface ResolveCandidate {
    id: number;
    linkedin_url: string;
    persona: string;
    score: number;
    first_detected_at: Date;
}
export function orderResolveCandidates<T extends ResolveCandidate>(rows: T[]): T[] {
    return rows
        .filter((r) => ['P1', 'P2', 'P3'].includes(r.persona) && isInternalProfileUrl(r.linkedin_url))
        .sort((a, b) => {
        if (a.score !== b.score)
            return b.score - a.score;
        const byTime = a.first_detected_at.getTime() - b.first_detected_at.getTime();
        if (byTime !== 0)
            return byTime;
        return a.id - b.id;
    });
}
export type UpgradePlan = {
    kind: 'resolved';
    canonicalUrl: string;
    slug: string;
    aliasUrls: string[];
} | {
    kind: 'no_slug';
};
export function planUpgrade(internalUrl: string, profile: UnipileProfile): UpgradePlan {
    const slug = profile.publicIdentifier?.trim().toLowerCase() || null;
    if (!slug || isInternalProfileId(slug))
        return { kind: 'no_slug' };
    const canonicalUrl = normalizeLinkedInUrl(`https://www.linkedin.com/in/${slug}`);
    if (!canonicalUrl || isInternalProfileUrl(canonicalUrl))
        return { kind: 'no_slug' };
    const alias = normalizeLinkedInUrl(internalUrl);
    return {
        kind: 'resolved',
        canonicalUrl,
        slug: linkedInSlug(canonicalUrl) ?? slug,
        aliasUrls: alias && alias !== canonicalUrl ? [alias] : [],
    };
}
function fullNameOf(profile: UnipileProfile): string | null {
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
    return name || null;
}
export async function runResolve(deps: ResolveDeps = {}): Promise<ResolveSummary> {
    if (config.unipile.mode !== 'live') {
        return summaryFor(false, `GROWTH_UNIPILE_MODE=${config.unipile.mode} — nothing resolved`);
    }
    const store = deps.store ?? repo;
    const now = deps.now ?? (() => new Date());
    const summary = summaryFor(true, 'available');
    const profilesUsed = await store.unitsToday('unipile_profile', now());
    const budget = new DailyCallBudget({
        callsUsed: 0,
        callCap: config.unipile.dailyCallCap,
        profilesUsed,
        profileCap: config.unipile.dailyProfileCap,
    }, async () => {
        summary.profileCalls += 1;
        await store.recordSpend('unipile_profile', 0, 1, { kind: 'profile', stage: 'resolve' });
    });
    const ledger = deps.store ? budget : productionUnipileLedger(async () => { summary.profileCalls += 1; });
    const client = (deps.makeClient ?? ((ledger) => new UnipileClient(undefined, undefined, { ledger })))(ledger);
    if (client.degraded) {
        summary.available = false;
        summary.reason = `${client.missingCredential} absent — nothing resolved`;
        log.warn('DEGRADED: unipile is live but a credential is missing — nothing resolved', {
            missing: client.missingCredential,
        });
        return summary;
    }
    const remaining = Math.max(0, config.unipile.dailyProfileCap - profilesUsed);
    if (remaining === 0) {
        summary.stopped = `daily profile cap reached (${profilesUsed}/${config.unipile.dailyProfileCap}) — resuming tomorrow`;
        log.warn('resolve stopped before starting', { reason: summary.stopped });
        return summary;
    }
    const candidates = orderResolveCandidates(await store.listResolveCandidates(500)).slice(0, Math.min(config.unipile.resolveBatch, remaining));
    for (const row of candidates) {
        const internalId = row.provider_id ?? linkedInSlug(row.linkedin_url);
        if (!internalId)
            continue;
        summary.attempted += 1;
        try {
            const read = await client.getUser(internalId);
            if (!read.data) {
                summary.failures += 1;
                log.error('profile read returned nothing', { prospectId: row.id, reason: read.degradedReason });
                continue;
            }
            const profile = read.data;
            const plan = planUpgrade(row.linkedin_url, profile);
            const location = profile.location;
            const { id: survivorId } = await store.upsertProspect({
                linkedinUrl: plan.kind === 'resolved' ? plan.canonicalUrl : row.linkedin_url,
                linkedinSlug: plan.kind === 'resolved' ? plan.slug : internalId,
                fullName: fullNameOf(profile),
                headline: profile.headline,
                location,
                countryClass: classifyCountry(location),
                isCompanyPage: false,
                companyName: null,
                profileJson: profile.raw,
                aliasUrls: plan.kind === 'resolved' ? plan.aliasUrls : [],
            });
            await store.recordResolveOutcome([row.id, survivorId], {
                outcome: plan.kind,
                isOpenProfile: profile.isOpenProfile,
                networkDistance: profile.networkDistance,
            });
            if (plan.kind === 'resolved') {
                summary.resolved += 1;
                log.info('prospect upgraded to a real slug', {
                    prospectId: row.id,
                    survivorId,
                    slug: plan.slug,
                    persona: row.persona,
                    score: row.score,
                });
            }
            else {
                summary.noSlug += 1;
                log.info('profile carries no public slug — kept its facts, will not retry', { prospectId: row.id });
            }
        }
        catch (err) {
            if (err instanceof UnipileError && err.notFound) {
                await store.recordResolveOutcome([row.id], { outcome: 'not_found' });
                summary.notFound += 1;
                log.info('profile not found — marked, never retried', { prospectId: row.id });
                continue;
            }
            const stop = stopReasonFor(err);
            if (stop) {
                summary.stopped = stop;
                log.error('resolve stopped', { prospectId: row.id, reason: stop });
                break;
            }
            summary.failures += 1;
            log.error('profile read failed', { prospectId: row.id, error: (err as Error).message });
        }
    }
    if (summary.failures > 0) {
        await store.openHold({
            subjectKind: 'lane',
            subjectId: null,
            stage: 'resolve',
            reason: `${summary.failures} profile read(s) failed this tick`,
            detail: { attempted: summary.attempted, failures: summary.failures },
        });
    }
    return summary;
}
