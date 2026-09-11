import { config } from '../../config/index.js';
export interface RampCaps {
    invitesPerDay: number;
    dmsPerDay: number;
    phase: 'week1' | 'steady' | 'paused';
}
export function rampCapsFor(now: Date, startDate: string | null | undefined): RampCaps {
    const start = startDate ? new Date(startDate) : null;
    if (!start || Number.isNaN(start.getTime())) {
        return { ...config.send.ramp.week1, phase: 'week1' };
    }
    const days = (now.getTime() - start.getTime()) / 86400000;
    if (days < config.send.ramp.week1Days)
        return { ...config.send.ramp.week1, phase: 'week1' };
    return { ...config.send.ramp.steady, phase: 'steady' };
}
export interface DmCandidate {
    prospectId: number;
    persona: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
    score: number;
    hasComment: boolean;
    signalCount: number;
    detectedAt: Date;
    isConnected: boolean;
    isOpenProfile: boolean;
    looksLikeSpam: boolean;
}
export type DmRoute = 'dm' | 'connect';
export function routeFor(candidate: DmCandidate): DmRoute {
    return candidate.isConnected || candidate.isOpenProfile ? 'dm' : 'connect';
}
export function admitsToDmLane(candidate: DmCandidate): boolean {
    return candidate.persona !== 'P0' && !candidate.looksLikeSpam;
}
const PERSONA_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3, P0: 9 };
export function prioritizeDmQueue(candidates: DmCandidate[]): DmCandidate[] {
    return [...candidates].filter(admitsToDmLane).sort((a, b) => {
        if (a.hasComment !== b.hasComment)
            return a.hasComment ? -1 : 1;
        if (a.hasComment && b.hasComment) {
            const rank = (PERSONA_RANK[a.persona] ?? 9) - (PERSONA_RANK[b.persona] ?? 9);
            if (rank !== 0)
                return rank;
        }
        const multiA = a.signalCount > 1 ? 0 : 1;
        const multiB = b.signalCount > 1 ? 0 : 1;
        if (multiA !== multiB)
            return multiA - multiB;
        if (a.score !== b.score)
            return b.score - a.score;
        return a.detectedAt.getTime() - b.detectedAt.getTime();
    });
}
export interface RationedQueue {
    dms: DmCandidate[];
    connects: DmCandidate[];
    deferred: DmCandidate[];
}
export function rationDmQueue(candidates: DmCandidate[], caps: RampCaps, alreadySentToday: {
    dms: number;
    connects: number;
} = { dms: 0, connects: 0 }): RationedQueue {
    const prioritized = prioritizeDmQueue(candidates);
    const dms: DmCandidate[] = [];
    const connects: DmCandidate[] = [];
    const deferred: DmCandidate[] = [];
    let dmBudget = Math.max(0, caps.dmsPerDay - alreadySentToday.dms);
    let connectBudget = Math.max(0, caps.invitesPerDay - alreadySentToday.connects);
    for (const candidate of prioritized) {
        if (caps.phase === 'paused') {
            deferred.push(candidate);
            continue;
        }
        if (routeFor(candidate) === 'dm') {
            if (dmBudget > 0) {
                dms.push(candidate);
                dmBudget -= 1;
            }
            else
                deferred.push(candidate);
        }
        else {
            if (connectBudget > 0) {
                connects.push(candidate);
                connectBudget -= 1;
            }
            else
                deferred.push(candidate);
        }
    }
    return { dms, connects, deferred };
}
