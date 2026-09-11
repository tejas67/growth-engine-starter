import { describe, expect, it } from 'vitest';
import { companyKey, isCompanyPageUrl, linkedInSlug, normalizeDomain, normalizeEmail, normalizeLinkedInUrl, planMerge, resolveByAliases, resolveCanonicalId, type AliasRow, type IdentityNode, } from '../src/lib/identity.js';
describe('organisation pages', () => {
    it('preserves a showcase URL instead of rewriting it to a company URL', () => {
        expect(normalizeLinkedInUrl('https://www.linkedin.com/showcase/sample-community-two/')).toBe('https://www.linkedin.com/showcase/sample-community-two');
        expect(linkedInSlug('https://www.linkedin.com/showcase/sample-community-two/')).toBe('sample-community-two');
        expect(isCompanyPageUrl('https://www.linkedin.com/showcase/sample-community-two/')).toBe(true);
        expect(isCompanyPageUrl('https://www.linkedin.com/company/sample-community')).toBe(true);
        expect(isCompanyPageUrl('https://www.linkedin.com/in/riley')).toBe(false);
    });
});
describe('normalizeLinkedInUrl', () => {
    it('canonicalizes every form of the same profile to one string', () => {
        const forms = [
            'https://www.linkedin.com/in/blair-example',
            'http://linkedin.com/in/blair-example/',
            'linkedin.com/in/blair-example',
            'https://www.linkedin.com/in/blair-example?utm_source=share&trk=feed',
            'https://uk.linkedin.com/in/blair-example',
        ];
        const normalized = forms.map(normalizeLinkedInUrl);
        expect(new Set(normalized).size).toBe(1);
        expect(normalized[0]).toBe('https://www.linkedin.com/in/blair-example');
    });
    it('rejects things that are not profile URLs', () => {
        expect(normalizeLinkedInUrl('https://example.com/in/someone')).toBeNull();
        expect(normalizeLinkedInUrl('https://www.linkedin.com/feed/')).toBeNull();
        expect(normalizeLinkedInUrl('')).toBeNull();
        expect(normalizeLinkedInUrl(null)).toBeNull();
    });
    it('keeps company pages distinguishable from people', () => {
        expect(isCompanyPageUrl('https://www.linkedin.com/company/sample labs')).toBe(true);
        expect(isCompanyPageUrl('https://www.linkedin.com/in/blair-example')).toBe(false);
        expect(linkedInSlug('https://www.linkedin.com/company/sample labs')).toBe('sample labs');
    });
});
describe('normalizeEmail', () => {
    it('lowercases and trims but does NOT strip gmail dots (that would over-merge)', () => {
        expect(normalizeEmail('  alex.example@sample-services.example ')).toBe('alex.example@sample-services.example');
        expect(normalizeEmail('alexexample@sample-services.example')).not.toBe(normalizeEmail('alex.example@sample-services.example'));
    });
    it('rejects malformed addresses', () => {
        expect(normalizeEmail('not-an-email')).toBeNull();
        expect(normalizeEmail('a@b')).toBeNull();
        expect(normalizeEmail('a@@b.com')).toBeNull();
    });
});
describe('normalizeDomain', () => {
    it('reduces a website to a registrable-ish host', () => {
        expect(normalizeDomain('https://www.sample robotics.com/careers?x=1')).toBe('sample robotics.com');
        expect(normalizeDomain('SAMPLE-SERVICES.EXAMPLE')).toBe('sample-services.example');
        expect(normalizeDomain('localhost')).toBeNull();
    });
});
describe('same person, two seed accounts', () => {
    it('resolves to ONE prospect — the dedup the whole engine depends on', () => {
        const fromRileyPost = normalizeLinkedInUrl('https://www.linkedin.com/in/alex-example?trk=feed');
        const fromKrogerPost = normalizeLinkedInUrl('http://linkedin.com/in/alex-example/');
        expect(fromRileyPost).toBe(fromKrogerPost);
        const aliasRows: AliasRow[] = [{ prospectId: 7, kind: 'linkedin_url', value: fromRileyPost! }];
        const nodes = new Map<number, IdentityNode>([[7, { id: 7, canonicalProspectId: null }]]);
        const hits = resolveByAliases(aliasRows, nodes, [
            { kind: 'linkedin_url', value: fromKrogerPost! },
        ]);
        expect(hits).toEqual([7]);
    });
});
describe('alias merge — slug change plus a new mailbox', () => {
    const nodes = new Map<number, IdentityNode>([
        [10, { id: 10, canonicalProspectId: null }],
        [42, { id: 42, canonicalProspectId: null }],
    ]);
    const aliasRows: AliasRow[] = [
        { prospectId: 10, kind: 'linkedin_url', value: 'https://www.linkedin.com/in/a-example-old' },
        { prospectId: 10, kind: 'email', value: 'jordan@sample-services.example' },
        { prospectId: 42, kind: 'linkedin_url', value: 'https://www.linkedin.com/in/alex-example' },
        { prospectId: 42, kind: 'email', value: 'jd@sample-services.example' },
    ];
    it('finds both rows from a probe that touches either identity', () => {
        const hits = resolveByAliases(aliasRows, nodes, [
            { kind: 'email', value: 'JD@sample-services.example' },
            { kind: 'linkedin_url', value: 'linkedin.com/in/a-example-old' },
        ]);
        expect(hits).toEqual([10, 42]);
    });
    it('plans a deterministic merge: the oldest id wins and carries every alias', () => {
        const plan = planMerge(aliasRows, nodes, [
            { kind: 'email', value: 'jd@sample-services.example' },
            { kind: 'linkedin_url', value: 'https://www.linkedin.com/in/a-example-old' },
        ]);
        expect(plan).not.toBeNull();
        expect(plan!.winnerId).toBe(10);
        expect(plan!.loserIds).toEqual([42]);
        const values = plan!.aliases.map((a) => a.value).sort();
        expect(values).toEqual([
            'https://www.linkedin.com/in/a-example-old',
            'https://www.linkedin.com/in/alex-example',
            'jd@sample-services.example',
            'jordan@sample-services.example',
        ]);
    });
    it('is idempotent — replaying the SAME merge produces the same winner and no new losers', () => {
        const probes = [
            { kind: 'email' as const, value: 'jd@sample-services.example' },
            { kind: 'email' as const, value: 'jordan@sample-services.example' },
        ];
        const first = planMerge(aliasRows, nodes, probes);
        expect(first!.winnerId).toBe(10);
        expect(first!.loserIds).toEqual([42]);
        const merged = new Map(nodes);
        merged.set(42, { id: 42, canonicalProspectId: 10 });
        const second = planMerge(aliasRows, merged, probes);
        expect(second!.winnerId).toBe(first!.winnerId);
        expect(second!.loserIds).toEqual([]);
    });
    it('after the merge, a probe on ANY alias lands on the surviving prospect', () => {
        const merged = new Map(nodes);
        merged.set(42, { id: 42, canonicalProspectId: 10 });
        const hits = resolveByAliases(aliasRows, merged, [
            { kind: 'linkedin_url', value: 'https://www.linkedin.com/in/alex-example' },
        ]);
        expect(hits).toEqual([10]);
    });
});
describe('resolveCanonicalId', () => {
    it('walks a chain to the terminal id', () => {
        const nodes = new Map<number, IdentityNode>([
            [1, { id: 1, canonicalProspectId: 2 }],
            [2, { id: 2, canonicalProspectId: 3 }],
            [3, { id: 3, canonicalProspectId: null }],
        ]);
        expect(resolveCanonicalId(nodes, 1)).toBe(3);
    });
    it('survives a corrupted cycle instead of hanging', () => {
        const nodes = new Map<number, IdentityNode>([
            [5, { id: 5, canonicalProspectId: 6 }],
            [6, { id: 6, canonicalProspectId: 5 }],
        ]);
        expect(resolveCanonicalId(nodes, 5)).toBe(5);
    });
});
describe('companyKey', () => {
    it('prefers a domain over a name — the single strong key', () => {
        expect(companyKey('Sample Robotics', 'https://sample robotics.com')).toBe('domain:sample robotics.com');
    });
    it('falls back to a normalized name when no domain exists', () => {
        expect(companyKey('KS Tech Group, LLC', null)).toBe('name:ks-tech-group');
    });
    it('returns null when there is nothing to key on', () => {
        expect(companyKey(null, null)).toBeNull();
    });
});
