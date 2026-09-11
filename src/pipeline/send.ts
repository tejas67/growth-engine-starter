import { readSettings } from '../../config/local.js';
import { config } from '../../config/index.js';
import type { DmResult, HeyReachClient } from '../clients/heyreach.js';
import { emailLaneAdmits, type EmailLaneMode } from '../guardrails/bounce_tripwire.js';
import { checkFrequencyCap, type TouchRecord } from '../guardrails/frequency_cap.js';
import { coldEmailAllowed } from '../guardrails/gov_gate.js';
import { rampCapsFor, type RampCaps } from '../guardrails/ramp.js';
import { verifyApprovedBytes, type TouchState } from '../approval/state.js';
import { logger } from '../lib/log.js';
const log = logger('send');
export interface DispatchTarget {
    touch: TouchState;
    isDemo?: boolean;
    channel: 'email' | 'dm' | 'connect';
    prospectId: number;
    linkedinUrl: string | null;
    fullName: string | null;
    email: string | null;
    emailVerifyStatus: string | null;
    companyName: string | null;
    headline: string | null;
    persona: string | null;
}
export interface DispatchContext {
    now: Date;
    suppression: {
        blocked: boolean;
        reason: string;
    };
    prospectTouches: TouchRecord[];
    sendingEnabled: boolean;
    emailLaneMode: EmailLaneMode;
    sentToday: {
        dms: number;
        connects: number;
        emails: number;
    };
    rampStartDate: string | null;
}
export type GateResult = {
    allowed: true;
    caps: RampCaps;
} | {
    allowed: false;
    reason: string;
    category: 'config' | 'kill_switch' | 'suppression' | 'cap' | 'gov' | 'integrity' | 'ramp';
};
export function evaluateDispatchGates(target: DispatchTarget, ctx: DispatchContext): GateResult {
    const caps = rampCapsFor(ctx.now, ctx.rampStartDate);
    if (target.isDemo || target.linkedinUrl?.includes('demo.invalid'))
        return { allowed: false, reason: 'Demo prospects cannot be sent', category: 'config' };
    const integrity = verifyApprovedBytes(target.touch, target.touch.subject, target.touch.body);
    if (!integrity.ok) {
        return { allowed: false, reason: integrity.reason, category: 'integrity' };
    }
    if (!ctx.sendingEnabled) {
        return { allowed: false, reason: 'lane_state kill_switch: sending disabled', category: 'kill_switch' };
    }
    if (ctx.suppression.blocked) {
        return { allowed: false, reason: ctx.suppression.reason, category: 'suppression' };
    }
    const cap = checkFrequencyCap(ctx.prospectTouches, ctx.now);
    if (!cap.allowed) {
        return { allowed: false, reason: `${cap.reason}: ${cap.detail}`, category: 'cap' };
    }
    if (config.dryRun)
        return { allowed: false, reason: 'Sending is paused in Settings', category: 'config' };
    if (!readSettings().integrations.campaignConfirmed)
        return { allowed: false, reason: 'Confirm your own HeyReach campaign setup in Settings', category: 'config' };
    if (target.channel === 'email') {
        if (!config.send.emailEnabled) {
            return { allowed: false, reason: 'email lane disabled in config', category: 'config' };
        }
        const gov = coldEmailAllowed({
            email: target.email,
            employer: target.companyName,
            headline: target.headline,
            persona: target.persona,
        });
        if (!gov.allowed)
            return { allowed: false, reason: gov.reason, category: 'gov' };
        if (!emailLaneAdmits(ctx.emailLaneMode, target.emailVerifyStatus)) {
            return {
                allowed: false,
                reason: `email lane is ${ctx.emailLaneMode}; address status is ${target.emailVerifyStatus ?? 'unknown'}`,
                category: 'cap',
            };
        }
        if (ctx.sentToday.emails >= config.send.emailPerDayCap) {
            return {
                allowed: false,
                reason: `daily email envelope reached (${config.send.emailPerDayCap})`,
                category: 'ramp',
            };
        }
        return { allowed: true, caps };
    }
    if (!config.send.dmEnabled) {
        return { allowed: false, reason: 'DM lane disabled in config', category: 'config' };
    }
    if (!target.linkedinUrl) {
        return { allowed: false, reason: 'no LinkedIn URL to send to', category: 'config' };
    }
    if (target.channel === 'dm' && ctx.sentToday.dms >= caps.dmsPerDay) {
        return { allowed: false, reason: `DM ramp cap reached (${caps.dmsPerDay}/day, ${caps.phase})`, category: 'ramp' };
    }
    if (target.channel === 'connect' && ctx.sentToday.connects >= caps.invitesPerDay) {
        return {
            allowed: false,
            reason: `invite ramp cap reached (${caps.invitesPerDay}/day, ${caps.phase})`,
            category: 'ramp',
        };
    }
    return { allowed: true, caps };
}
export interface SendOutcome {
    touchId: number;
    dispatched: boolean;
    dryRun: boolean;
    reason: string;
    providerMessageId: string | null;
    providerThreadId: string | null;
}
export async function dispatchOne(target: DispatchTarget, ctx: DispatchContext, heyreach: HeyReachClient): Promise<SendOutcome> {
    const gate = evaluateDispatchGates(target, ctx);
    if (!gate.allowed) {
        log.info('dispatch refused', { touchId: target.touch.id, category: gate.category, reason: gate.reason });
        return {
            touchId: target.touch.id,
            dispatched: false,
            dryRun: config.dryRun,
            reason: `${gate.category}: ${gate.reason}`,
            providerMessageId: null,
            providerThreadId: null,
        };
    }
    if (target.channel === 'email') {
        log.info('email dispatch is bridge-owned — printing instead', {
            touchId: target.touch.id,
            to: target.email,
            subject: target.touch.subject,
        });
        return {
            touchId: target.touch.id,
            dispatched: false,
            dryRun: true,
            reason: 'email lane rides the platform bridge (not in this scaffold) — printed, not sent',
            providerMessageId: null,
            providerThreadId: null,
        };
    }
    const result: DmResult = await heyreach.send({
        linkedinUrl: target.linkedinUrl!,
        message: target.touch.body,
        note: target.touch.connectNote,
        kind: target.channel,
        campaignId: config.send.heyreachCampaignId,
        linkedInAccountId: config.send.heyreachLinkedInAccountId,
        firstName: target.fullName?.split(' ')[0] ?? null,
        lastName: target.fullName?.split(' ').slice(1).join(' ') || null,
        correlationId: `li-t${target.touch.id}`,
    });
    return {
        touchId: target.touch.id,
        dispatched: result.dispatched,
        dryRun: result.dryRun,
        reason: result.reason,
        providerMessageId: result.providerMessageId,
        providerThreadId: result.providerThreadId,
    };
}
