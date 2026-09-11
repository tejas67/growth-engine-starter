import { config } from '../../config/index.js';
import { daysBetween } from '../lib/time.js';
export type Channel = 'email' | 'dm' | 'connect';
export interface TouchRecord {
    id: number;
    prospectId: number;
    channel: Channel;
    sentAt: Date | null;
    status: string;
}
export type CapDecision = {
    allowed: true;
    reason: 'no_prior_touches' | 'within_open_sequence';
} | {
    allowed: false;
    reason: 'sequence_cap_90d' | 'sequence_touch_limit' | 'sequence_span_elapsed';
    detail: string;
};
export interface CapOptions {
    frequencyCapDays?: number;
    maxTouchesPerSequence?: number;
    sequenceSpanDays?: number;
}
export function checkFrequencyCap(touches: TouchRecord[], now: Date, opts: CapOptions = {}): CapDecision {
    const capDays = opts.frequencyCapDays ?? config.guardrails.frequencyCapDays;
    const maxTouches = opts.maxTouchesPerSequence ?? config.guardrails.maxTouchesPerSequence;
    const spanDays = opts.sequenceSpanDays ?? config.guardrails.sequenceSpanDays;
    const sent = touches
        .filter((t) => t.sentAt !== null && (t.status === 'sent' || t.status === 'delivered'))
        .sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime());
    if (sent.length === 0)
        return { allowed: true, reason: 'no_prior_touches' };
    const first = sent[0]!.sentAt!;
    const last = sent[sent.length - 1]!.sentAt!;
    const withinSpan = daysBetween(first, now) <= spanDays;
    if (withinSpan) {
        if (sent.length >= maxTouches) {
            return {
                allowed: false,
                reason: 'sequence_touch_limit',
                detail: `${sent.length} touches already sent in the current sequence (max ${maxTouches})`,
            };
        }
        return { allowed: true, reason: 'within_open_sequence' };
    }
    const sinceLast = daysBetween(last, now);
    if (sinceLast < capDays) {
        return {
            allowed: false,
            reason: 'sequence_cap_90d',
            detail: `last touch ${sinceLast.toFixed(1)}d ago; cap is ${capDays}d across all channels and aliases`,
        };
    }
    return { allowed: true, reason: 'no_prior_touches' };
}
