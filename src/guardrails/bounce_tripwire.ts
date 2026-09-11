import { config } from '../../config/index.js';
export interface SendRecord {
    touchId: number;
    sentAt: Date;
    hardBouncedAt: Date | null;
}
export interface TripwireState {
    tripped: boolean;
    hardBounces: number;
    windowSize: number;
    sendsConsidered: number;
    reason: string;
}
export interface TripwireOptions {
    count?: number;
    window?: number;
}
export function evaluateBounceTripwire(sends: SendRecord[], now: Date, opts: TripwireOptions = {}): TripwireState {
    const threshold = opts.count ?? config.guardrails.bounceTripwireCount;
    const windowSize = opts.window ?? config.guardrails.bounceTripwireWindow;
    const ordered = [...sends].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    const window = ordered.slice(-windowSize);
    const hardBounces = window.filter((s) => s.hardBouncedAt !== null && s.hardBouncedAt.getTime() <= now.getTime()).length;
    const tripped = hardBounces >= threshold;
    return {
        tripped,
        hardBounces,
        windowSize,
        sendsConsidered: window.length,
        reason: tripped
            ? `${hardBounces} hard bounces in the last ${window.length} sends (threshold ${threshold} per rolling ${windowSize}) — email lane restricted to verified-good addresses`
            : `${hardBounces} hard bounces in the last ${window.length} sends (threshold ${threshold})`,
    };
}
export type EmailLaneMode = 'all' | 'good_only';
export function emailLaneAdmits(mode: EmailLaneMode, verifyStatus: string | null): boolean {
    if (verifyStatus === 'invalid')
        return false;
    if (mode === 'good_only')
        return verifyStatus === 'good';
    return verifyStatus !== 'invalid';
}
