import { describe, expect, it } from 'vitest';
import { BANNED_PHRASES, lintDraft } from '../src/copy/lint.js';
import { assignShape, buildDraftPrompt, companyEvidenceFor, draftOne, preDraftGate, type DraftCandidate } from '../src/pipeline/draft.js';
const APPROVED_A_EXAMPLE = 'Jordan, Orlando sim and training has more federal doors than any vertical I have mapped , ' +
    'PEO STRI alone keeps half the town busy, and most of those programs never show up in anyone’s alerts. ' +
    'Does Sample Services usually hear about them early or late?';
const APPROVED_B_BOLLING = 'Hi J, Owner here, founder of Growth Engine. I built a tool (Sample Customer is an example customer) ' +
    'working on the same problem you live daily: finding the federal work that actually fits a small business ' +
    'instead of drowning in SAM. I would love to hear what is working for KS Tech right now.';
describe('the approved wave-0 drafts pass', () => {
    it('accepts the homework-led shape', () => {
        const result = lintDraft(APPROVED_A_EXAMPLE, { channel: 'dm' });
        expect(result.ok).toBe(true);
        expect(result.violations.filter((v) => v.severity === 'error')).toHaveLength(0);
    });
    it('now rejects the old intro-led advice request', () => {
        expect(lintDraft(APPROVED_B_BOLLING, { channel: 'dm' }).violations.map(v => v.rule)).toContain('invented_interest');
    });
});
describe('v4 rules from the founder, 2026-09-03', () => {
    it('rejects an em dash or en dash anywhere', () => {
        expect(lintDraft('Hey Colin — Owner here. Plain otherwise.', { channel: 'dm' }).violations.map((v) => v.rule)).toContain('dash');
        expect(lintDraft('Hey Colin – Owner here.', { channel: 'dm' }).violations.map((v) => v.rule)).toContain('dash');
        expect(lintDraft('Hey Colin, Owner here. A hyphen-joined word is fine.', { channel: 'dm' }).violations.map((v) => v.rule)).not.toContain('dash');
    });
    it('rejects "X, not Y" and "not X but Y" contrast framing', () => {
        for (const body of [
            'Most of the failure I have watched came from latency, not bad intent.',
            'It is not the pathway, but the people running it.',
            'This is not just a policy problem but a staffing one.',
        ]) {
            expect(lintDraft(body, { channel: 'dm' }).violations.map((v) => v.rule), body).toContain('contrast_framing');
        }
        expect(lintDraft('Latency did most of the damage in the programs I watched.', { channel: 'dm' }).violations.map((v) => v.rule)).not.toContain('contrast_framing');
    });
    it('rejects "you asked" (they spoke to the room, never to Owner) and warns on softer attributions', () => {
        const asked = lintDraft("You asked what I'd propose on the gov side.", { channel: 'dm' });
        expect(asked.ok).toBe(false);
        expect(asked.violations.map((v) => v.rule)).toContain('banned_phrase');
        const said = lintDraft('What you said about reform being a delivery problem lands with me.', { channel: 'dm' });
        expect(said.violations.find((v) => v.rule === 'attributed_speech')?.severity).toBe('warn');
    });
});
describe('audit 2026-09-08: no claimed homework, no stock connectors', () => {
    it('rejects claimed research and the repeated connectors', () => {
        for (const body of [
            'I read up on the alignment side of what you do.',
            'I came across US AI last week.',
            'Would like to compare notes.',
            'Tampa keeps showing up in that work.',
        ]) {
            expect(lintDraft(body, { channel: 'dm' }).violations.map((v) => v.rule), body).toContain('banned_phrase');
        }
        expect(lintDraft('I built a tool that maps a small company to the programs it can actually go after.', { channel: 'dm' }).ok).toBe(true);
    });
});
describe('banned phrases', () => {
    it.each(BANNED_PHRASES)('rejects a draft containing "%s"', (phrase) => {
        const result = lintDraft(`Jordan, some plain opening sentence here. ${phrase} something else.`, {
            channel: 'dm',
        });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.rule === 'banned_phrase')).toBe(true);
    });
    it('catches the exact v1 failure the founder rejected', () => {
        const v1 = 'Jordan, Sample Services is exactly the kind of company we built Growth Engine for. ' +
            'Happy to show you what we found. Worth a look?';
        const result = lintDraft(v1, { channel: 'dm' });
        expect(result.ok).toBe(false);
        expect(result.violations.length).toBeGreaterThanOrEqual(3);
    });
});
describe('the empathy rule — never reference the act of watching', () => {
    it.each([
        'Jordan, saw your comment on the acquisition thread and wanted to reach across.',
        'Noticed your engagement with defense content recently, thought I would say hello.',
        'You liked a post about PEO STRI, so I figured this was relevant to your work.',
        'Jordan, I came across your comment about federal doors in Orlando this week.',
    ])('rejects: %s', (body) => {
        const result = lintDraft(body, { channel: 'dm' });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.rule === 'empathy_rule')).toBe(true);
    });
    it('allows engaging their POINT without naming where it was seen', () => {
        const ok = 'Jordan, the argument that most federal programs never surface in anyone’s alerts matches what I see ' +
            'in Orlando specifically. Does Sample Services hear about PEO STRI work early or late?';
        expect(lintDraft(ok, { channel: 'dm' }).ok).toBe(true);
    });
});
describe('structural tells', () => {
    it('rejects a colon-hook opener', () => {
        const result = lintDraft('Founder hat question: how do you find federal work today?', { channel: 'dm' });
        expect(result.violations.some((v) => v.rule === 'colon_hook_opener')).toBe(true);
    });
    it('rejects triplet slogans', () => {
        const result = lintDraft('Jordan, here is the pitch in one line. Real programs, real buyers, no noise. What do you think?', { channel: 'dm' });
        expect(result.violations.some((v) => v.rule === 'triplet_slogan')).toBe(true);
    });
});
describe('injection resistance', () => {
    it('rejects a draft that lifts a run of scraped text verbatim', () => {
        const scraped = 'We spent our whole first year bidding everything and won nothing and it nearly ended the company for good';
        const body = `J, you said you spent your whole first year bidding everything and won nothing and it nearly ended the company for good. What changed in year two?`;
        const result = lintDraft(body, { channel: 'dm', scrapedText: [scraped] });
        expect(result.violations.some((v) => v.rule === 'scraped_verbatim')).toBe(true);
    });
    it('rejects an unapproved URL — scraped content must never smuggle a link out', () => {
        const result = lintDraft('Jordan, take a look at https://evil.example.com/claim for the list.', {
            channel: 'dm',
        });
        expect(result.violations.some((v) => v.rule === 'unapproved_url')).toBe(true);
    });
    it('allows our own attribution link when it is explicitly permitted', () => {
        const result = lintDraft('Jordan, the list is here if you want it: https://app.example.invalid/signup?ref=li-t901', { channel: 'dm', allowedUrlPrefixes: ['https://app.example.invalid/'] });
        expect(result.violations.some((v) => v.rule === 'unapproved_url')).toBe(false);
    });
});
describe('channel limits', () => {
    it('rejects a connection note over LinkedIn’s 300-character cap', () => {
        const result = lintDraft('x'.repeat(320), { channel: 'connect' });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.rule === 'connect_note_length')).toBe(true);
    });
    it('only WARNS on a long DM — it is off-doctrine, not unsafe', () => {
        const result = lintDraft(`Jordan, ${'a plain sentence about federal work. '.repeat(30)}`, {
            channel: 'dm',
        });
        expect(result.ok).toBe(true);
        expect(result.violations.some((v) => v.rule === 'dm_length' && v.severity === 'warn')).toBe(true);
    });
});
describe('pre-draft gates', () => {
    const candidate = (overrides: Partial<DraftCandidate> = {}): DraftCandidate => ({
        prospectId: 4,
        channel: 'dm',
        fullName: 'Alex Example',
        firstName: 'Jordan',
        headline: 'Founder of sample-services.example',
        location: 'Oviedo, Florida, United States',
        companyName: 'sample-services.example',
        companyDomain: 'sample-services.example',
        companyVerified: true,
        persona: 'P1',
        score: 82,
        email: null,
        isGov: false,
        signalType: 'like',
        commentText: null,
        postTopic: null,
        detectedAt: new Date('2026-08-15T10:00:00Z'),
        seedAccountId: 1,
        matchProof: null,
        ...overrides,
    });
    it('admits an unverified company to the DM lane (F5: everyone but junk)', () => {
        const gate = preDraftGate(candidate({ channel: 'dm', companyVerified: false }));
        expect(gate.ok).toBe(true);
    });
    it('BLOCKS a product-proof EMAIL for an unverified company (rubric v0.3)', () => {
        const gate = preDraftGate(candidate({ channel: 'email', companyVerified: false, email: 'x@example.com' }));
        expect(gate.ok).toBe(false);
        expect(gate.reason).toContain('no product-proof email ships without company verification');
    });
    it('the prompt hides an unverified company and forbids naming one', () => {
        const prompt = buildDraftPrompt(candidate({ companyVerified: false, companyName: 'Acme Robotics' }), 'A-hw');
        expect(prompt).not.toContain('Acme Robotics');
        expect(prompt).toContain('UNKNOWN');
    });
    it('supplies verified company evidence and makes the absence of match work explicit', () => {
        const evidence = [{ title: 'Sample Services', link: 'https://sample-services.example', snippet: 'Builds simulation tools for training.' }];
        const prompt = buildDraftPrompt(candidate({ companyEvidence: evidence }), 'A-hw');
        expect(prompt).toContain('Builds simulation tools for training.');
        expect(prompt).toContain('No recipient-specific research deliverable has been supplied');
        expect(buildDraftPrompt(candidate({ companyVerified: false, companyEvidence: evidence }), 'A-hw')).not.toContain('Builds simulation tools for training.');
    });
    it('lint rejects a DM that names the unverified company anyway', () => {
        const lint = lintDraft('Saw the work coming out of Acme Robotics on autonomy. What are you building next?', {
            channel: 'dm',
            forbiddenNames: ['Acme Robotics'],
        });
        expect(lint.ok).toBe(false);
        expect(lint.violations.map((v) => v.rule)).toContain('unverified_company_named');
    });
    it('blocks P0 outright', () => {
        expect(preDraftGate(candidate({ persona: 'P0' })).ok).toBe(false);
    });
    it('blocks P4 from the EMAIL lane specifically', () => {
        const gate = preDraftGate(candidate({ channel: 'email', persona: 'P4', email: 'x@example.com' }));
        expect(gate.ok).toBe(false);
        expect(gate.reason).toContain('founder-touch list');
    });
    it('refuses a product-proof email with no proof, rather than padding the numbers', () => {
        const gate = preDraftGate(candidate({ channel: 'email', email: 'jordan@sample-services.example', matchProof: null }));
        expect(gate.ok).toBe(false);
        expect(gate.reason).toContain('DM-only');
    });
    it('allows a product-proof email once real numbers exist', () => {
        const gate = preDraftGate(candidate({
            channel: 'email',
            email: 'jordan@sample-services.example',
            matchProof: {
                matchCount: 7,
                potentialTotalUsd: 1250000,
                agencies: ['Navy'],
                highlights: [],
                producedAt: new Date('2026-08-15T09:00:00Z'),
            },
        }));
        expect(gate.ok).toBe(true);
    });
    it('allows the DM lane for a verified P1', () => {
        expect(preDraftGate(candidate()).ok).toBe(true);
    });
});
describe('A/B assignment', () => {
    it('is deterministic — a re-draft lands in the SAME cell', () => {
        expect(assignShape(4)).toBe(assignShape(4));
        expect(assignShape(4)).not.toBe(assignShape(5));
    });
    it('splits the population evenly across the two shapes', () => {
        const counts = { 'A-hw': 0, 'B-intro': 0 };
        for (let i = 0; i < 100; i++)
            counts[assignShape(i)] += 1;
        expect(counts['A-hw']).toBe(50);
        expect(counts['B-intro']).toBe(50);
    });
});
describe('honest outreach', () => {
    it.each([
        'Your focus on governance made me wonder how you assess fit.',
        "I'd like to connect and learn about your work at EarlyWarn.ai.",
        'I would value your criticism of where that search gets difficult.',
        "I'd love to hear how you identify the right person.",
    ])('rejects observed synthetic interest: %s', body => {
        expect(lintDraft(body).violations.map(v => v.rule)).toContain('invented_interest');
    });
    it('distinguishes offering work from falsely claiming it already happened', () => {
        for (const body of ['I found three programs for you.', 'We have a shortlist for your company.', "I've put together a report."]) {
            expect(lintDraft(body, { hasMatchProof: false }).violations.map(v => v.rule)).toContain('unsupported_match_work');
        }
        expect(lintDraft('I can check for relevant programs and send you any matches.', { hasMatchProof: false }).ok).toBe(true);
        expect(lintDraft('I found three programs for you.', { hasMatchProof: true }).ok).toBe(true);
    });
    it('uses only excerpts on the verified domain, excluding lookalikes and unrelated results', () => {
        const hit = (link: string) => ({ title: 'Company', link, snippet: 'Simulation tools for training.' });
        expect(companyEvidenceFor('sample-services.example', [hit('https://sample-services.example/about'), hit('https://docs.sample-services.example/product'),
            hit('https://sample-services.example.attacker.test'), hit('https://other.test'), hit('javascript:alert(1)'), null]))
            .toEqual([hit('https://sample-services.example/about'), hit('https://docs.sample-services.example/product')]);
        expect(companyEvidenceFor(null, [hit('https://sample-services.example')])).toEqual([]);
    });
    it('records a relevance hold without retrying it as a provider error or generating filler', async () => {
        let calls = 0;
        const c: DraftCandidate = { prospectId: 1, channel: 'dm', fullName: 'Someone', firstName: 'Someone', headline: 'Founder',
            location: null, companyName: null, companyDomain: null, companyVerified: false, persona: 'P1', score: 70, email: null,
            isGov: false, signalType: 'like', commentText: null, postTopic: null, detectedAt: new Date(), seedAccountId: null, matchProof: null };
        const result = await draftOne(c, '', async () => { calls++; return JSON.stringify({ decision: 'hold', reason: 'No company work or federal responsibility is known.' }); }, new Date());
        expect(calls).toBe(1);
        expect(result).toMatchObject({ kind: 'rejected', rejection: { kind: 'hold', reason: 'no_relevant_offer' } });
        expect(result.kind === 'rejected' && result.rejection.kind === 'hold' && result.rejection.providerUnavailable).not.toBe(true);
    });
});
