import { config } from '../../config/index.js';
export type Lane = 'email' | 'dm';
export interface TouchFact {
    touchId: number;
    prospectId: number;
    channel: 'email' | 'dm' | 'connect';
    persona: string | null;
    templateVersion: string;
    angle: string | null;
    seedAccountId: number | null;
    signalType: string | null;
    latencyBucket: string | null;
    matchCount: number | null;
    founderEdited: boolean;
    sentAt: Date | null;
    dryRun: boolean;
}
export interface EventFact {
    touchId: number | null;
    prospectId: number | null;
    kind: string;
    occurredAt: Date;
}
export interface FunnelStage {
    name: string;
    count: number;
    rate: number | null;
}
export interface LaneFunnel {
    lane: Lane;
    stages: FunnelStage[];
    n: number;
    belowFloor: boolean;
    note: string;
}
const EMAIL_STAGES = ['sent', 'clicked', 'claimed', 'activated'] as const;
const DM_STAGES = ['sent', 'reply', 'positive_reply', 'signed_in'] as const;
function countByKind(events: EventFact[], touchIds: Set<number>): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    for (const e of events) {
        if (e.touchId === null || !touchIds.has(e.touchId))
            continue;
        if (!out.has(e.kind))
            out.set(e.kind, new Set());
        out.get(e.kind)!.add(e.touchId);
    }
    return out;
}
export function buildFunnel(lane: Lane, touches: TouchFact[], events: EventFact[], minN = config.dashboard.minCellN): LaneFunnel {
    const laneTouches = touches.filter((t) => lane === 'email' ? t.channel === 'email' : t.channel === 'dm' || t.channel === 'connect');
    const sent = laneTouches.filter((t) => t.sentAt !== null && !t.dryRun);
    const touchIds = new Set(sent.map((t) => t.touchId));
    const byKind = countByKind(events, touchIds);
    const names = lane === 'email' ? EMAIL_STAGES : DM_STAGES;
    const stages: FunnelStage[] = [];
    let previous = sent.length;
    for (const name of names) {
        const count = name === 'sent' ? sent.length : (byKind.get(name)?.size ?? 0);
        stages.push({
            name,
            count,
            rate: previous >= minN && name !== 'sent' ? count / previous : null,
        });
        if (name !== 'sent')
            previous = count;
    }
    return {
        lane,
        stages,
        n: sent.length,
        belowFloor: sent.length < minN,
        note: sent.length < minN
            ? `only ${sent.length} real ${sent.length === 1 ? 'send' : 'sends'} in this lane — below the ${minN}-send reporting floor, rates are not shown`
            : `${sent.length} real sends`,
    };
}
export interface Cell {
    key: string;
    sends: number;
    replies: number;
    positive: number;
    positiveRate: number | null;
    belowFloor: boolean;
}
export function cutBy(touches: TouchFact[], events: EventFact[], dimension: (t: TouchFact) => string | null, minN = config.dashboard.minCellN): Cell[] {
    const eligible = touches.filter((t) => t.sentAt !== null && !t.dryRun && !t.founderEdited);
    const byTouch = new Map<number, Set<string>>();
    for (const e of events) {
        if (e.touchId === null)
            continue;
        if (!byTouch.has(e.touchId))
            byTouch.set(e.touchId, new Set());
        byTouch.get(e.touchId)!.add(e.kind);
    }
    const groups = new Map<string, TouchFact[]>();
    for (const t of eligible) {
        const key = dimension(t) ?? '(unset)';
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key)!.push(t);
    }
    return [...groups.entries()]
        .map(([key, group]) => {
        const replies = group.filter((t) => {
            const kinds = byTouch.get(t.touchId);
            return kinds?.has('reply') || kinds?.has('positive_reply') || kinds?.has('negative_reply');
        }).length;
        const positive = group.filter((t) => byTouch.get(t.touchId)?.has('positive_reply')).length;
        const belowFloor = group.length < minN;
        return {
            key,
            sends: group.length,
            replies,
            positive,
            positiveRate: belowFloor ? null : positive / group.length,
            belowFloor,
        };
    })
        .sort((a, b) => b.sends - a.sends);
}
export interface GraduationVerdict {
    templateVersion: string;
    persona: string;
    sends: number;
    positive: number;
    positiveRate: number;
    recommendation: 'graduate' | 'keep_testing' | 'kill' | 'insufficient_data';
    note: string;
}
export function graduationVerdicts(touches: TouchFact[], events: EventFact[], minSends = config.graduation.minSends, minRate = config.graduation.minPositiveReplyRate): GraduationVerdict[] {
    const cells = cutBy(touches, events, (t) => `${t.templateVersion}|${t.persona ?? 'unknown'}`, 1);
    return cells.map((cell) => {
        const [templateVersion = '', persona = ''] = cell.key.split('|');
        const rate = cell.sends > 0 ? cell.positive / cell.sends : 0;
        if (cell.sends < minSends) {
            return {
                templateVersion,
                persona,
                sends: cell.sends,
                positive: cell.positive,
                positiveRate: rate,
                recommendation: 'insufficient_data',
                note: `${cell.sends}/${minSends} sends — nothing to conclude yet (founder-edited sends excluded)`,
            };
        }
        if (rate >= minRate) {
            return {
                templateVersion,
                persona,
                sends: cell.sends,
                positive: cell.positive,
                positiveRate: rate,
                recommendation: 'graduate',
                note: `${(rate * 100).toFixed(1)}% positive over ${cell.sends} sends — clears the bar. Founder flips the switch.`,
            };
        }
        if (rate < minRate / 2) {
            return {
                templateVersion,
                persona,
                sends: cell.sends,
                positive: cell.positive,
                positiveRate: rate,
                recommendation: 'kill',
                note: `${(rate * 100).toFixed(1)}% positive over ${cell.sends} sends — less than half the bar`,
            };
        }
        return {
            templateVersion,
            persona,
            sends: cell.sends,
            positive: cell.positive,
            positiveRate: rate,
            recommendation: 'keep_testing',
            note: `${(rate * 100).toFixed(1)}% positive over ${cell.sends} sends — under the bar but not dead`,
        };
    });
}
export const SELECTION_BIAS_NOTE = 'Founder approval means observed rates conflate copy quality with founder selection: ' +
    'a draft that reached a recipient was one the founder chose to send. Treat cross-template ' +
    'comparisons as directional, and read the founder_edited exclusion as partial, not complete, correction.';
