import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approve, type TouchState } from '../src/approval/state.js';
import { evaluateDispatchGates, type DispatchContext, type DispatchTarget } from '../src/pipeline/send.js';
import { HeyReachClient } from '../src/clients/heyreach.js';
const NOW = new Date('2026-08-15T12:00:00.000Z');
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.doUnmock('../config/local.js');
    vi.resetModules();
});
function approvedTouch(body = 'Jordan, a plain and specific opening about Orlando.'): TouchState {
    return approve({
        id: 77,
        status: 'draft',
        subject: null,
        connectNote: null,
        body,
        templateVersion: 'A-hw@v2',
        founderEdited: false,
        contentHash: null,
        approvedAt: null,
        approvedBy: null,
        skippedAt: null,
    }, 'owner', NOW).touch;
}
function target(overrides: Partial<DispatchTarget> = {}): DispatchTarget {
    return {
        touch: approvedTouch(),
        channel: 'dm',
        prospectId: 55,
        linkedinUrl: 'https://www.linkedin.com/in/alex-example',
        fullName: null,
        email: null,
        emailVerifyStatus: null,
        companyName: 'sample-services.example',
        headline: 'Founder of sample-services.example',
        persona: 'P1',
        ...overrides,
    };
}
function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
    return {
        now: NOW,
        suppression: { blocked: false, reason: 'clear' },
        prospectTouches: [],
        sendingEnabled: true,
        emailLaneMode: 'all',
        sentToday: { dms: 0, connects: 0, emails: 0 },
        rampStartDate: '2026-08-14',
        ...overrides,
    };
}
describe('safe defaults', () => {
    it('refuses a DM because the channel is disabled by default', () => {
        const gate = evaluateDispatchGates(target(), ctx());
        expect(gate.allowed).toBe(false);
        if (!gate.allowed)
            expect(gate.category).toBe('config');
    });
    it('refuses an email because that channel is disabled by default too', () => {
        const gate = evaluateDispatchGates(target({ channel: 'email', email: 'jordan@sample-services.example', emailVerifyStatus: 'good' }), ctx());
        expect(gate.allowed).toBe(false);
        if (!gate.allowed)
            expect(gate.category).toBe('config');
    });
    it('the HeyReach client prints instead of posting when not live', async () => {
        const client = new HeyReachClient('', 'dry_run');
        const result = await client.send({
            linkedinUrl: 'https://www.linkedin.com/in/alex-example',
            message: 'hello',
            kind: 'dm',
            campaignId: 'x',
            linkedInAccountId: '1001',
            correlationId: 'li-t77',
        });
        expect(result.dispatched).toBe(false);
        expect(result.dryRun).toBe(true);
        expect(result.reason).toContain('nothing was transmitted');
    });
    it('the client refuses an over-length connection note before any network call', async () => {
        const client = new HeyReachClient('', 'dry_run');
        const result = await client.send({
            linkedinUrl: 'https://www.linkedin.com/in/x',
            message: 'x'.repeat(301),
            kind: 'connect',
            campaignId: 'x',
            linkedInAccountId: '1001',
            correlationId: 'li-t77',
        });
        expect(result.dispatched).toBe(false);
        expect(result.reason).toContain('300');
    });
});
describe('gates that fire regardless of the channel switch', () => {
    it('REFUSES when the approved bytes no longer match — no re-render is ever sent', () => {
        const tampered = { ...approvedTouch(), body: 'something else entirely was substituted here' };
        const gate = evaluateDispatchGates(target({ touch: tampered }), ctx());
        expect(gate.allowed).toBe(false);
        if (!gate.allowed) {
            expect(gate.category).toBe('integrity');
            expect(gate.reason).toContain('re-render');
        }
    });
    it('refuses when the runtime kill switch is off', () => {
        const gate = evaluateDispatchGates(target(), ctx({ sendingEnabled: false }));
        expect(gate.allowed).toBe(false);
        if (!gate.allowed)
            expect(gate.category).toBe('kill_switch');
    });
    it('LAST-MOMENT check: a reply that arrived after approval still stops the send', () => {
        const gate = evaluateDispatchGates(target(), ctx({ suppression: { blocked: true, reason: 'sequence paused pending founder triage' } }));
        expect(gate.allowed).toBe(false);
        if (!gate.allowed) {
            expect(gate.category).toBe('suppression');
            expect(gate.reason).toContain('paused');
        }
    });
    it('reports a paused prospect as paused, not as rate-limited', () => {
        const gate = evaluateDispatchGates(target(), ctx({
            suppression: { blocked: true, reason: 'prospect or an alias is suppressed' },
            sentToday: { dms: 999, connects: 999, emails: 999 },
        }));
        if (!gate.allowed)
            expect(gate.category).toBe('suppression');
    });
    it('refuses when the cross-channel frequency cap is spent', () => {
        const gate = evaluateDispatchGates(target(), ctx({
            prospectTouches: [
                {
                    id: 1,
                    prospectId: 55,
                    channel: 'email',
                    sentAt: new Date(NOW.getTime() - 40 * 86400000),
                    status: 'sent',
                },
            ],
        }));
        expect(gate.allowed).toBe(false);
        if (!gate.allowed)
            expect(gate.category).toBe('cap');
    });
});
describe('with the DM channel deliberately enabled', () => {
    it('allows a clean DM, and enforces the week-1 ramp cap', async () => {
        vi.doMock('../config/local.js', async () => { const actual = await vi.importActual<typeof import('../config/local.js')>('../config/local.js'); return { ...actual, readSettings: () => actual.SettingsSchema.parse({ integrations: { sendingEnabled: true, campaignConfirmed: true } }) }; });
        vi.resetModules();
        const { evaluateDispatchGates: gates } = await import('../src/pipeline/send.js');
        const clean = gates(target(), ctx());
        expect(clean.allowed).toBe(true);
        if (clean.allowed)
            expect(clean.caps.phase).toBe('week1');
        const capped = gates(target(), ctx({ sentToday: { dms: 15, connects: 0, emails: 0 } }));
        expect(capped.allowed).toBe(false);
        if (!capped.allowed) {
            expect(capped.category).toBe('ramp');
            expect(capped.reason).toContain('15/day');
        }
    });
    it('moves to steady-state caps after the ramp week', async () => {
        vi.doMock('../config/local.js', async () => { const actual = await vi.importActual<typeof import('../config/local.js')>('../config/local.js'); return { ...actual, readSettings: () => actual.SettingsSchema.parse({ integrations: { sendingEnabled: true, campaignConfirmed: true } }) }; });
        vi.resetModules();
        const { evaluateDispatchGates: gates } = await import('../src/pipeline/send.js');
        const gate = gates(target(), ctx({ rampStartDate: '2026-08-01', sentToday: { dms: 20, connects: 0, emails: 0 } }));
        expect(gate.allowed).toBe(true);
        if (gate.allowed)
            expect(gate.caps.dmsPerDay).toBe(30);
    });
    it('treats a missing ramp start date as day one — conservative by construction', async () => {
        vi.doMock('../config/local.js', async () => { const actual = await vi.importActual<typeof import('../config/local.js')>('../config/local.js'); return { ...actual, readSettings: () => actual.SettingsSchema.parse({ integrations: { sendingEnabled: true, campaignConfirmed: true } }) }; });
        vi.resetModules();
        const { evaluateDispatchGates: gates } = await import('../src/pipeline/send.js');
        const gate = gates(target(), ctx({ rampStartDate: null }));
        expect(gate.allowed).toBe(true);
        if (gate.allowed)
            expect(gate.caps.phase).toBe('week1');
    });
});
describe('standalone email lane', () => { it('stays disabled even when old environment flags are set', async () => { vi.stubEnv('GROWTH_EMAIL_SEND_ENABLED', 'true'); vi.resetModules(); const { config } = await import('../config/index.js'); expect(config.send.emailEnabled).toBe(false); }); });
