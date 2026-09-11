import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApolloPerson } from '../src/clients/apollo.js';
import { normalizeApollo } from '../src/clients/apollo.js';
import { StaticSearchProvider } from '../src/clients/search.js';
import { planEnrichment, hitRate, type EnrichTarget } from '../src/pipeline/enrich.js';
import { buildQuery, hostMatchesName, verifyCompany } from '../src/pipeline/verify_company.js';
import { parseSeedCsv, splitCsvLine } from '../src/seeds/load_seed_accounts.js';
import { deriveAlarms, renderDigest, type DigestModel } from '../src/report/digest.js';
const NOW = new Date('2026-08-15T12:00:00.000Z');
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});
describe('company verification — the wave-0 lesson', () => {
    it('verifies a company whose own site is in the results', async () => {
        const provider = new StaticSearchProvider({
            [buildQuery({ companyName: 'Sample Robotics', headline: 'manufacturing' })]: [
                { title: 'Sample Robotics - Fast manufacturing', link: 'https://sample robotics.com', snippet: 'Manufacturing tech.' },
                { title: 'Sample Robotics | LinkedIn', link: 'https://linkedin.com/company/sample robotics', snippet: '' },
            ],
        });
        const result = await verifyCompany({ companyName: 'Sample Robotics', headline: 'manufacturing' }, provider);
        expect(result.verdict).toBe('verified');
        expect(result.verifiedDomain).toBe('sample robotics.com');
    });
    it('confirms a domain asserted in the headline (sample-services.example)', async () => {
        const input = {
            companyName: 'sample-services.example',
            headline: 'Founder of simulation software',
            assertedDomain: 'sample-services.example',
        };
        const provider = new StaticSearchProvider({
            [buildQuery(input)]: [
                { title: 'Sample Services', link: 'https://sample-services.example/', snippet: 'Simulation and training software.' },
            ],
        });
        const result = await verifyCompany(input, provider);
        expect(result.verdict).toBe('verified');
        expect(result.verifiedDomain).toBe('sample-services.example');
    });
    it('returns INCONCLUSIVE — not a guess — when two hosts both plausibly match', async () => {
        const input = { companyName: 'Bastion', headline: 'cleared contractors' };
        const provider = new StaticSearchProvider({
            [buildQuery(input)]: [
                { title: 'Bastion Software', link: 'https://bastionsoftware.com', snippet: 'FSO command center.' },
                { title: 'Bastion Security', link: 'https://bastion.io', snippet: 'Unrelated company.' },
            ],
        });
        const result = await verifyCompany(input, provider);
        expect(result.verdict).toBe('inconclusive');
        expect(result.summary).toContain('ambiguous');
        expect(result.verifiedDomain).toBeNull();
    });
    it('returns INCONCLUSIVE when nothing comes back at all', async () => {
        const result = await verifyCompany({ companyName: 'Sample Consulting' }, new StaticSearchProvider({}));
        expect(result.verdict).toBe('inconclusive');
        expect(result.summary).toContain('hold pool');
    });
    it('ignores directory and social hosts — they are never a company site', async () => {
        const provider = new StaticSearchProvider({
            [buildQuery({ companyName: 'Sample Systems' })]: [
                { title: 'Sample Systems | LinkedIn', link: 'https://www.linkedin.com/company/sample systems', snippet: '' },
                { title: 'Sample Systems - ZoomInfo', link: 'https://www.zoominfo.com/c/sample systems', snippet: '' },
            ],
        });
        const result = await verifyCompany({ companyName: 'Sample Systems' }, provider);
        expect(result.verdict).toBe('inconclusive');
    });
    it('matches hosts to names loosely but not wildly', () => {
        expect(hostMatchesName('sample-services.example', 'sample-services.example')).toBe(true);
        expect(hostMatchesName('sample robotics.com', 'Sample Robotics')).toBe(true);
        expect(hostMatchesName('example.com', 'Sample Robotics')).toBe(false);
    });
    it('builds a query with distinguishing context, not just the bare name', () => {
        const query = buildQuery({ companyName: 'Bastion', headline: 'FSO command center for cleared contractors' });
        expect(query).toContain('Bastion');
        expect(query.split(' ').length).toBeGreaterThan(2);
    });
});
describe('enrichment merge policy', () => {
    const target = (overrides: Partial<EnrichTarget> = {}): EnrichTarget => ({
        prospectId: 4,
        linkedinUrl: 'https://www.linkedin.com/in/alex-example',
        fullName: 'Alex Example',
        headline: 'Founder of sample-services.example',
        companyName: 'sample-services.example',
        companyDomain: 'sample-services.example',
        companyVerified: true,
        email: null,
        ...overrides,
    });
    const person = (overrides: Partial<ApolloPerson> = {}): ApolloPerson => ({
        matched: true,
        email: 'jordan@sample-services.example',
        emailStatus: 'verified',
        firstName: 'Jordan',
        lastName: 'Example',
        title: 'Founder',
        companyName: 'Sample Services',
        companyDomain: 'sample-services.example',
        companyEmployees: 14,
        companyIndustry: 'computer software',
        city: 'Oviedo',
        state: 'Florida',
        country: 'United States',
        raw: {},
        costUsd: 0.02,
        ...overrides,
    });
    it('fills a missing mailbox and asks for a re-score', () => {
        const outcome = planEnrichment(target(), person());
        expect(outcome.patch.email).toBe('jordan@sample-services.example');
        expect(outcome.rescoreNeeded).toBe(true);
    });
    it('NEVER overwrites an existing mailbox', () => {
        const outcome = planEnrichment(target({ email: 'already@known.com' }), person());
        expect(outcome.patch.email).toBe('already@known.com');
    });
    it('keeps the VERIFIED domain when Apollo disagrees, and records the conflict', () => {
        const outcome = planEnrichment(target(), person({ companyDomain: 'someothercompany.com' }));
        expect(outcome.patch.companyDomain).toBe('sample-services.example');
        expect(outcome.firmographics?.domain_conflict).toBeDefined();
        expect(outcome.note).toContain('verified domain kept');
    });
    it('routes a no-match to the DM-only lane as a dimension, not an error', () => {
        const outcome = planEnrichment(target(), person({ matched: false }));
        expect(outcome.matched).toBe(false);
        expect(outcome.note).toContain('no_proof');
        expect(outcome.rescoreNeeded).toBe(false);
    });
    it('flags a gov mailbox found during enrichment', () => {
        const outcome = planEnrichment(target({ companyVerified: false, companyDomain: null }), person({ email: 'someone@navy.mil' }));
        expect(outcome.patch.isGov).toBe(true);
        expect(outcome.patch.govReason).toContain('.mil');
    });
    it('reports when the Apollo hit rate falls below the waterfall trigger', () => {
        expect(hitRate(10, 7).belowFloor).toBe(false);
        expect(hitRate(10, 4).belowFloor).toBe(true);
        expect(hitRate(0, 0).belowFloor).toBe(false);
    });
    it('normalizes a raw Apollo body without inventing fields', () => {
        const normalized = normalizeApollo({
            person: {
                email: 'A@B.COM',
                first_name: 'A',
                organization: { name: 'Acme', website_url: 'https://www.acme.com/about' },
            },
        });
        expect(normalized.email).toBe('a@b.com');
        expect(normalized.companyDomain).toBe('acme.com');
        expect(normalized.companyEmployees).toBeNull();
    });
    it('handles an empty Apollo response', () => {
        expect(normalizeApollo({}).matched).toBe(false);
    });
});
describe('seed CSV loader', () => {
    it('parses the shipped Day-1 file shape', () => {
        const csv = [
            'slug,kind,display_name,linkedin_url,tier,track,cadence_class,notes',
            'riley,person,Riley Parks,https://www.linkedin.com/in/riley,1,true,active,"P2 audience, 80 engagers"',
            'blair-example,person,Blair Example,,1,true,active,"Best measured yield"',
            'tylersweatt,person,Tyler Sweatt,,1,true,repost_heavy,"engagers sit on the original"',
            'steveblank,person,Steve Blank,,2,true,dormant,"zero posts in the month window"',
        ].join('\n');
        const { rows, errors } = parseSeedCsv(csv);
        expect(errors).toHaveLength(0);
        expect(rows).toHaveLength(4);
        expect(rows[1]!.linkedinUrl).toBe('https://www.linkedin.com/in/blair-example');
        expect(rows[2]!.cadenceClass).toBe('repost_heavy');
        expect(rows[3]!.tier).toBe(2);
    });
    it('handles quoted fields containing commas', () => {
        expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
        expect(splitCsvLine('a,"say ""hi""",d')).toEqual(['a', 'say "hi"', 'd']);
    });
    it('derives a company URL for a company seed', () => {
        const { rows } = parseSeedCsv('slug,kind\nsample-aerospace,company');
        expect(rows[0]!.linkedinUrl).toBe('https://www.linkedin.com/company/sample-aerospace');
    });
    it('reports a bad row instead of silently dropping the file', () => {
        const { rows, errors } = parseSeedCsv('slug,kind\n,person\nriley,person');
        expect(rows).toHaveLength(1);
        expect(errors[0]).toContain('missing slug');
    });
    it('rejects a file without the required columns', () => {
        const { errors } = parseSeedCsv('name,url\nx,y');
        expect(errors[0]).toContain('slug');
    });
    it('defaults an unknown cadence class rather than guessing', () => {
        const { rows } = parseSeedCsv('slug,kind,cadence_class\nriley,person,whatever');
        expect(rows[0]!.cadenceClass).toBe('unknown');
    });
});
describe('digest — loud zero and alarms', () => {
    const model = (overrides: Partial<DigestModel> = {}): DigestModel => ({
        day: '2026-08-15',
        generatedAt: NOW,
        dryRun: true,
        seeds: [
            { slug: 'riley', cadenceClass: 'active', postsSeen: 3, engagersSeen: 80, consecutiveZeroDays: 0, lastOutcome: 'ok' },
            { slug: 'ecoffie', cadenceClass: 'dormant', postsSeen: 0, engagersSeen: 0, consecutiveZeroDays: 4, lastOutcome: 'zero' },
        ],
        prospects: { new: 81, scored: 60, verified: 12, enriched: 9 },
        drafts: { created: 6, awaitingApproval: 6, oldestDraftAgeHours: 30 },
        sends: { dms: 0, connects: 0, emails: 0, dryRunOnly: 6 },
        replies: { total: 0, unmatched: 0, awaitingTriage: 0 },
        holds: [{ stage: 'verify', count: 3 }],
        spend: [{ category: 'apify', spentUsd: 0.65, capUsd: 6, units: 158 }],
        tripwire: { emailLaneMode: 'all', hardBouncesInWindow: 0, windowSize: 0 },
        linkedin: { paused: false, reason: null },
        alarms: [],
        ...overrides,
    });
    it('LOUD-ZEROES a silent account rather than omitting it', () => {
        const markdown = renderDigest(model());
        expect(markdown).toContain('ecoffie');
        expect(markdown).toContain('ZERO');
    });
    it('says plainly when nothing was transmitted', () => {
        expect(renderDigest(model())).toContain('DRY RUN IS ON');
    });
    it('shows draft age without expiring anything', () => {
        const markdown = renderDigest(model());
        expect(markdown).toContain('oldest unapproved draft');
        expect(markdown).not.toContain('expired');
    });
    it('alarms on a slug that has gone quiet for too long', () => {
        const alarms = deriveAlarms(model());
        expect(alarms.some((a) => a.includes('ecoffie') && a.includes('zero-engager days'))).toBe(true);
    });
    it('alarms when the bounce tripwire has restricted the lane', () => {
        const alarms = deriveAlarms(model({ tripwire: { emailLaneMode: 'good_only', hardBouncesInWindow: 3, windowSize: 40 } }));
        expect(alarms.some((a) => a.includes('bounce tripwire is TRIPPED'))).toBe(true);
    });
    it('alarms when LinkedIn has paused the campaign', () => {
        const alarms = deriveAlarms(model({ linkedin: { paused: true, reason: 'account restriction' } }));
        expect(alarms.some((a) => a.includes('LinkedIn campaign is paused'))).toBe(true);
    });
    it('alarms on a deep hold queue', () => {
        const alarms = deriveAlarms(model({ holds: [{ stage: 'score', count: 40 }] }));
        expect(alarms.some((a) => a.includes('hold queue is 40 deep'))).toBe(true);
    });
    it('alarms on an unmatched reply — someone is waiting on an answer', () => {
        const alarms = deriveAlarms(model({ replies: { total: 2, unmatched: 1, awaitingTriage: 1 } }));
        expect(alarms.some((a) => a.includes('could not be matched'))).toBe(true);
        expect(alarms.some((a) => a.includes('awaiting your reply triage'))).toBe(true);
    });
    it('alarms when a spend cap is reached, and says coverage is preserved', () => {
        const alarms = deriveAlarms(model({ spend: [{ category: 'apify', spentUsd: 6, capUsd: 6, units: 900 }] }));
        expect(alarms.some((a) => a.includes('cadence degraded, coverage preserved'))).toBe(true);
    });
    it('says "none" rather than hiding the section on a clean day', () => {
        const markdown = renderDigest(model({ seeds: [], holds: [], spend: [] }));
        expect(markdown).toContain('## Alarms');
        expect(markdown).toContain('- none');
    });
});
