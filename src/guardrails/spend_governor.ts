import { config } from '../../config/index.js';
export type ScrapeKind = 'posts' | 'engagers' | 'retirement_snapshot' | 'company_posts';
export interface ScrapeRequest {
    kind: ScrapeKind;
    estimatedResults: number;
    postAgeHours: number | null;
    minutesSinceLastScrape: number | null;
    cadenceClass?: string | null;
}
export interface GovernorDecision {
    proceed: boolean;
    reason: string;
    estimatedCostUsd: number;
    degradedIntervalMinutes: number | null;
}
export interface BudgetSnapshot {
    spentTodayUsd: number;
    capUsd: number;
}
function estimateCost(req: ScrapeRequest): number {
    const unit = req.kind === 'posts' || req.kind === 'company_posts'
        ? config.scrape.costPerPostUsd
        : config.scrape.costPerEngagerUsd;
    return Number((req.estimatedResults * unit).toFixed(4));
}
export function baseIntervalMinutes(req: ScrapeRequest): number {
    if (req.kind === 'posts' || req.kind === 'company_posts') {
        return req.cadenceClass === 'dormant'
            ? config.scrape.cadenceMinutes.dormantPostDetect
            : config.scrape.cadenceMinutes.newPostDetect;
    }
    const age = req.postAgeHours ?? 0;
    return age < 24
        ? config.scrape.cadenceMinutes.engagersFresh
        : config.scrape.cadenceMinutes.engagersTail;
}
export function decide(req: ScrapeRequest, budget: BudgetSnapshot): GovernorDecision {
    const cost = estimateCost(req);
    const remaining = budget.capUsd - budget.spentTodayUsd;
    if (req.kind === 'retirement_snapshot') {
        return { proceed: true, reason: 'exempt', estimatedCostUsd: cost, degradedIntervalMinutes: null };
    }
    const base = baseIntervalMinutes(req);
    const since = req.minutesSinceLastScrape;
    const pressure = remaining <= 0 ? Infinity : cost / remaining;
    let interval = base;
    if (pressure > 1)
        interval = base * 8;
    else if (pressure > 0.5)
        interval = base * 4;
    else if (pressure > 0.25)
        interval = base * 2;
    if (since !== null && since < interval) {
        return {
            proceed: false,
            reason: interval > base ? 'cadence_backoff' : 'too_soon',
            estimatedCostUsd: cost,
            degradedIntervalMinutes: interval > base ? interval : null,
        };
    }
    if (remaining <= 0) {
        return {
            proceed: false,
            reason: 'budget_exhausted',
            estimatedCostUsd: cost,
            degradedIntervalMinutes: interval,
        };
    }
    return {
        proceed: true,
        reason: interval > base ? 'cadence_backoff' : 'ok',
        estimatedCostUsd: cost,
        degradedIntervalMinutes: interval > base ? interval : null,
    };
}
export function zeroDayVerdict(consecutiveZeroDays: number, sawEngagersToday: boolean, threshold = config.scrape.zeroDaysBeforeFlag): {
    consecutiveZeroDays: number;
    flagged: boolean;
    note: string;
} {
    if (sawEngagersToday) {
        return { consecutiveZeroDays: 0, flagged: false, note: 'engagers seen' };
    }
    const next = consecutiveZeroDays + 1;
    return {
        consecutiveZeroDays: next,
        flagged: next >= threshold,
        note: next >= threshold
            ? `${next} consecutive zero-engager days — verify the slug is alive (dead slug vs quiet account)`
            : `${next} zero-engager day(s) — quiet, not yet suspicious`,
    };
}
