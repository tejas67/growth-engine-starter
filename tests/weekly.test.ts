import { describe, expect, it } from 'vitest';
import { isoWeekKey, isoWeekStart, renderWeekly, type WeeklyModel } from '../src/report/weekly.js';
function model(overrides: Partial<WeeklyModel> = {}): WeeklyModel {
    return {
        week: '2026-W36',
        windowStart: new Date('2026-08-31T00:00:00.000Z'),
        windowEnd: new Date('2026-09-02T12:00:00.000Z'),
        generatedAt: new Date('2026-09-02T12:00:00.000Z'),
        dryRun: false,
        volumes: {
            sends: 3,
            sendsPreviousWeek: 0,
            byChannel: [{ channel: 'dm', count: 3 }],
            replies: 1,
            positiveReplies: 1,
            claims: 0,
            signups: 0,
            meetings: 0,
        },
        funnels: [],
        primary: [
            { key: 'P1', sends: 3, replies: 1, positive: 1, positiveRate: null, belowFloor: true },
        ],
        exploratory: [],
        graduation: [],
        health: {
            prospectsByState: [{ state: 'scored', count: 40 }],
            holdsByStage: [],
            apollo: { attempts: 0, matches: 0, hitRate: null },
            emailReach: { seeded: 0, noProof: 0, awaitingApproval: 0, sent: 0 },
            silentSeeds: [],
        },
        narrative: { text: null, reason: 'GROWTH_LLM_MODE is dry_run, so no model was called' },
        ...overrides,
    };
}
describe('ISO week keys', () => {
    it('uses the ISO year, so the end of December files under the right week', () => {
        expect(isoWeekKey(new Date('2026-12-31T12:00:00.000Z'))).toBe('2026-W53');
        expect(isoWeekKey(new Date('2027-01-01T12:00:00.000Z'))).toBe('2026-W53');
        expect(isoWeekKey(new Date('2025-12-29T12:00:00.000Z'))).toBe('2026-W01');
    });
    it('starts the week on Monday, in UTC', () => {
        expect(isoWeekStart(new Date('2026-09-02T23:00:00.000Z')).toISOString()).toBe('2026-08-31T00:00:00.000Z');
        expect(isoWeekStart(new Date('2026-09-06T12:00:00.000Z')).toISOString()).toBe('2026-08-31T00:00:00.000Z');
    });
});
describe('the readout refuses to manufacture a rate', () => {
    it('prints counts and says why, when a cell is below the floor', () => {
        const markdown = renderWeekly(model());
        expect(markdown).not.toContain('33');
        expect(markdown).toContain('below the 10-send floor');
        expect(markdown).toContain('too small to read');
    });
    it('says the commentary is missing rather than leaving a blank section', () => {
        const markdown = renderWeekly(model());
        expect(markdown).toContain('No written analysis this week');
        expect(markdown).toContain('computed from the database, not written by');
    });
    it('includes the model\'s commentary when there is one', () => {
        const markdown = renderWeekly(model({ narrative: { text: '### Recommendations\n\nKill A2 on P2.', reason: 'written by Claude' } }));
        expect(markdown).toContain('Kill A2 on P2.');
        expect(markdown).not.toContain('No written analysis');
    });
    it('names the selection bias every single week', () => {
        expect(renderWeekly(model())).toContain('founder selection');
    });
    it('marks every exploratory cut as exploratory', () => {
        const markdown = renderWeekly(model({
            exploratory: [
                {
                    title: 'Angle',
                    description: 'one row per copy angle',
                    cells: [{ key: 'A1', sends: 2, replies: 0, positive: 0, positiveRate: null, belowFloor: true }],
                },
            ],
        }));
        expect(markdown).toContain('### Angle _(exploratory)_');
    });
    it('counts one send as a send, not as "1 sends"', () => {
        const markdown = renderWeekly(model({
            volumes: { ...model().volumes, sends: 1 },
            primary: [{ key: 'P1', sends: 1, replies: 0, positive: 0, positiveRate: null, belowFloor: true }],
        }));
        expect(markdown).toContain('**1 send**');
        expect(markdown).not.toContain('1 sends');
    });
    it('shows a real rate once a cell clears the floor', () => {
        const markdown = renderWeekly(model({
            primary: [{ key: 'P1', sends: 60, replies: 9, positive: 6, positiveRate: 0.1, belowFloor: false }],
        }));
        expect(markdown).toContain('10.0%');
        expect(markdown).not.toContain('too small to read');
    });
    it('reports graduation per template x persona, never in aggregate', () => {
        const markdown = renderWeekly(model({
            graduation: [
                {
                    templateVersion: 'A-hw@v2',
                    persona: 'P1',
                    sends: 60,
                    positive: 6,
                    positiveRate: 0.1,
                    recommendation: 'graduate',
                    note: 'clears the bar',
                },
                {
                    templateVersion: 'A-hw@v2',
                    persona: 'P2',
                    sends: 4,
                    positive: 0,
                    positiveRate: 0,
                    recommendation: 'insufficient_data',
                    note: '4/50 sends',
                },
            ],
        }));
        expect(markdown).toContain('| A-hw@v2 | P1 |');
        expect(markdown).toContain('| A-hw@v2 | P2 |');
        expect(markdown).toContain('**graduate**');
        expect(markdown).toContain('**insufficient_data**');
        expect(markdown).toContain('Founder-edited sends are excluded');
    });
});
