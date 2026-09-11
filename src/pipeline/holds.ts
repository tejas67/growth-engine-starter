export const RETRYABLE_HOLD_REASONS = ['transport', 'timeout', 'rate_limit'] as const;
export interface HoldRow {
    id: number;
    subject_kind: string;
    subject_id: number | null;
    stage: string;
    reason: string;
    detail: unknown;
    created_at: Date;
}
export interface HoldReleaseFilter {
    stage?: string | null;
    reasons?: string[];
    allOfKind?: boolean;
}
export interface HoldReleasePlan {
    holdIds: number[];
    prospectIds: number[];
    resolvedOnly: number[];
    skipped: Array<{
        id: number;
        reason: string;
    }>;
}
export interface HoldReleaseArgs extends HoldReleaseFilter {
    dryRun: boolean;
}
export function parseHoldReleaseArgs(argv: string[]): HoldReleaseArgs {
    const args: HoldReleaseArgs = { stage: null, reasons: [], allOfKind: false, dryRun: false };
    const list = (raw: string | undefined): string[] => (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--stage')
            args.stage = argv[++i] ?? null;
        else if (arg.startsWith('--stage='))
            args.stage = arg.slice('--stage='.length);
        else if (arg === '--reason')
            args.reasons = list(argv[++i]);
        else if (arg.startsWith('--reason='))
            args.reasons = list(arg.slice('--reason='.length));
        else if (arg === '--all-of-kind')
            args.allOfKind = true;
        else if (arg === '--dry-run')
            args.dryRun = true;
    }
    return args;
}
function haystack(hold: HoldRow): string {
    const detail = hold.detail === null || hold.detail === undefined ? '' : JSON.stringify(hold.detail);
    return `${hold.reason} ${detail}`.toLowerCase();
}
export function isRetryableHold(hold: HoldRow): boolean {
    const text = haystack(hold);
    return RETRYABLE_HOLD_REASONS.some((r) => text.includes(r));
}
export function planHoldRelease(holds: HoldRow[], filter: HoldReleaseFilter): HoldReleasePlan {
    const plan: HoldReleasePlan = { holdIds: [], prospectIds: [], resolvedOnly: [], skipped: [] };
    const needles = (filter.reasons ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean);
    for (const hold of holds) {
        if (filter.stage && hold.stage !== filter.stage) {
            plan.skipped.push({ id: hold.id, reason: `stage ${hold.stage}` });
            continue;
        }
        if (!filter.allOfKind) {
            if (needles.length === 0) {
                plan.skipped.push({ id: hold.id, reason: 'no reason filter and --all-of-kind not given' });
                continue;
            }
            const text = haystack(hold);
            if (!needles.some((n) => text.includes(n))) {
                plan.skipped.push({ id: hold.id, reason: `reason "${hold.reason}"` });
                continue;
            }
        }
        plan.holdIds.push(hold.id);
        if (hold.subject_kind === 'prospect' && hold.subject_id !== null) {
            plan.prospectIds.push(hold.subject_id);
        }
        else {
            plan.resolvedOnly.push(hold.id);
        }
    }
    plan.prospectIds = [...new Set(plan.prospectIds)];
    return plan;
}
