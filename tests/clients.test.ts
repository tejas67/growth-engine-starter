import { describe, expect, it } from 'vitest';
import { ApifyClient, buildPostsInput, type FetchLike } from '../src/clients/apify.js';
import { ApolloClient } from '../src/clients/apollo.js';
import { HeyReachClient } from '../src/clients/heyreach.js';
import { ImapFlowReader } from '../src/clients/imap.js';
import { MillionVerifierClient, mapVerifyResult } from '../src/clients/millionverifier.js';
interface RecordedCall {
    url: string;
    method: string;
    body: string | null;
}
function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
    impl: FetchLike;
    calls: RecordedCall[];
} {
    const calls: RecordedCall[] = [];
    const impl: FetchLike = async (url, init) => {
        calls.push({
            url,
            method: (init?.method ?? 'GET').toUpperCase(),
            body: typeof init?.body === 'string' ? init.body : null,
        });
        return handler(url, init);
    };
    return { impl, calls };
}
function noNetwork(): {
    impl: FetchLike;
    calls: RecordedCall[];
} {
    return fakeFetch((url) => {
        throw new Error(`the client called out when it must not have: ${url}`);
    });
}
const immediately = async (): Promise<void> => undefined;
describe('absent credentials degrade loudly instead of throwing', () => {
    it('apify: no token in live mode returns an offline result and calls nobody', async () => {
        const net = noNetwork();
        const client = new ApifyClient('', 'live', { fetchImpl: net.impl, sleep: immediately });
        expect(client.degraded).toBe(true);
        const run = await client.runProfilePosts(buildPostsInput({ targetUrls: ['https://www.linkedin.com/in/no-such-slug-for-tests'] }));
        expect(net.calls).toHaveLength(0);
        expect(run.mode).toBe('live');
        expect(run.effectiveMode).toBe('dry_run');
        expect(run.costUsd).toBe(0);
        expect(run.costSource).toBe('none');
        expect(run.runId).toBeNull();
        expect(run.degradedReason).toMatch(/APIFY_TOKEN absent/);
    });
    it('apollo: no key in live mode returns an unmatched person, not an exception', async () => {
        const net = noNetwork();
        const client = new ApolloClient('', 'live', { fetchImpl: net.impl });
        expect(client.degraded).toBe(true);
        const person = await client.peopleMatchByLinkedIn('https://www.linkedin.com/in/alex-example');
        expect(net.calls).toHaveLength(0);
        expect(person.matched).toBe(false);
        expect(person.costUsd).toBe(0);
        expect(person.effectiveMode).toBe('dry_run');
        expect(person.degradedReason).toMatch(/APOLLO_API_KEY absent/);
    });
    it('heyreach: no key in live mode refuses the dispatch, it does not throw', async () => {
        const net = noNetwork();
        const client = new HeyReachClient('', 'live', { fetchImpl: net.impl });
        expect(client.degraded).toBe(true);
        const result = await client.send({
            linkedinUrl: 'https://www.linkedin.com/in/alex-example',
            message: 'hello',
            kind: 'dm',
            campaignId: 'camp-1',
            linkedInAccountId: '1001',
            correlationId: 'li-t1',
        });
        expect(net.calls).toHaveLength(0);
        expect(result.dispatched).toBe(false);
        expect(result.dryRun).toBe(true);
        expect(result.providerMessageId).toBeNull();
        expect(result.reason).toMatch(/HEYREACH_API_KEY absent/);
    });
    it('heyreach: a live key with no campaign id also refuses rather than posting', async () => {
        const net = noNetwork();
        const client = new HeyReachClient('key', 'live', { fetchImpl: net.impl });
        const result = await client.send({
            linkedinUrl: 'https://www.linkedin.com/in/alex-example',
            message: 'hello',
            kind: 'dm',
            campaignId: '',
            linkedInAccountId: '1001',
            correlationId: 'li-t1',
        });
        expect(net.calls).toHaveLength(0);
        expect(result.dispatched).toBe(false);
        expect(result.reason).toMatch(/HEYREACH_CAMPAIGN_ID absent/);
    });
    it('heyreach: reply fetch with no key returns nothing rather than failing ingest', async () => {
        const net = noNetwork();
        const client = new HeyReachClient('', 'live', { fetchImpl: net.impl });
        await expect(client.fetchReplies(new Date('2026-08-01T00:00:00Z'))).resolves.toEqual([]);
        expect(net.calls).toHaveLength(0);
    });
    it('millionverifier: no key returns unverified with no request and no cost', async () => {
        const net = noNetwork();
        const client = new MillionVerifierClient('', 'live', { fetchImpl: net.impl });
        expect(client.degraded).toBe(true);
        const result = await client.verify('jordan@sample-services.example');
        expect(net.calls).toHaveLength(0);
        expect(result.status).toBe('unverified');
        expect(result.costUsd).toBe(0);
        expect(result.effectiveMode).toBe('dry_run');
        expect(result.reason).toMatch(/MILLIONVERIFIER_KEY absent/);
    });
    it('imap: enabled with no credentials reads nothing rather than throwing', async () => {
        const reader = new ImapFlowReader({ enabled: true, user: '', password: '' });
        expect(reader.degraded).toBe(true);
        expect(reader.configured).toBe(false);
        await expect(reader.fetchSince(new Date('2026-08-01T00:00:00Z'))).resolves.toEqual([]);
        const probe = await reader.probe();
        expect(probe.ok).toBe(false);
        expect(probe.configured).toBe(false);
        expect(probe.detail).toMatch(/IMAP_USER/);
    });
    it('imap: switched off is a normal state, not a failure', async () => {
        const reader = new ImapFlowReader({ enabled: false });
        expect(reader.degraded).toBe(false);
        const probe = await reader.probe();
        expect(probe.ok).toBe(true);
        expect(probe.configured).toBe(false);
    });
});
describe('apify run lifecycle', () => {
    function lifecycle(opts: {
        finalStatus: string;
        items?: unknown[];
        usageTotalUsd?: number | null;
        pollsBeforeTerminal?: number;
    }) {
        let polls = 0;
        return fakeFetch((url) => {
            if (url.includes('/v2/acts/')) {
                return json({ data: { id: 'run-1', status: 'RUNNING', defaultDatasetId: 'ds-1' } });
            }
            if (url.includes('/v2/actor-runs/run-1/abort')) {
                return json({ data: { id: 'run-1', status: 'ABORTED' } });
            }
            if (url.includes('/v2/actor-runs/run-1')) {
                polls += 1;
                const terminal = polls >= (opts.pollsBeforeTerminal ?? 1);
                return json({
                    data: {
                        id: 'run-1',
                        status: terminal ? opts.finalStatus : 'RUNNING',
                        defaultDatasetId: 'ds-1',
                        ...(opts.usageTotalUsd === undefined ? {} : { usageTotalUsd: opts.usageTotalUsd }),
                    },
                });
            }
            if (url.includes('/v2/datasets/ds-1/items')) {
                return json(opts.items ?? []);
            }
            throw new Error(`unexpected url: ${url}`);
        });
    }
    const input = buildPostsInput({
        targetUrls: ['https://www.linkedin.com/in/blair-example'],
    });
    it('starts the run, polls to SUCCEEDED, then reads the dataset', async () => {
        const net = lifecycle({
            finalStatus: 'SUCCEEDED',
            items: [{ id: 'p1' }, { id: 'p2' }],
            usageTotalUsd: 0.1234,
            pollsBeforeTerminal: 2,
        });
        const client = new ApifyClient('token', 'live', { fetchImpl: net.impl, sleep: immediately });
        const run = await client.runProfilePosts(input);
        expect(run.items).toHaveLength(2);
        expect(run.effectiveMode).toBe('live');
        expect(run.runId).toBe('run-1');
        const start = net.calls[0];
        expect(start?.method).toBe('POST');
        expect(start?.url).toContain('/v2/acts/harvestapi~linkedin-profile-posts/runs');
        expect(start?.url).toContain('maxTotalChargeUsd=1');
        expect(start?.body).toContain('"postedLimit":"week"');
        expect(start?.body).toContain('"targetUrls":["https://www.linkedin.com/in/blair-example"]');
        expect(net.calls.filter((c) => c.url.endsWith('/v2/actor-runs/run-1'))).toHaveLength(2);
        expect(net.calls.at(-1)?.url).toContain('/v2/datasets/ds-1/items');
    });
    it("prefers Apify's own reported charge over our per-result estimate", async () => {
        const net = lifecycle({
            finalStatus: 'SUCCEEDED',
            items: [{ id: 'p1' }, { id: 'p2' }],
            usageTotalUsd: 0.5,
        });
        const client = new ApifyClient('token', 'live', { fetchImpl: net.impl, sleep: immediately });
        const run = await client.runProfilePosts(input);
        expect(run.costUsd).toBe(0.5);
        expect(run.costSource).toBe('apify_reported');
    });
    it('falls back to the per-result estimate when the run reports no charge', async () => {
        const net = lifecycle({
            finalStatus: 'SUCCEEDED',
            items: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
            usageTotalUsd: null,
        });
        const client = new ApifyClient('token', 'live', { fetchImpl: net.impl, sleep: immediately });
        const run = await client.runProfilePosts(input);
        expect(run.costUsd).toBeCloseTo(0.006, 6);
        expect(run.costSource).toBe('estimated');
    });
    it('surfaces a FAILED run as an error — a dead actor is not a quiet day', async () => {
        const net = lifecycle({ finalStatus: 'FAILED' });
        const client = new ApifyClient('token', 'live', { fetchImpl: net.impl, sleep: immediately });
        await expect(client.runProfilePosts(input)).rejects.toThrow(/ended FAILED/);
        expect(net.calls.some((c) => c.url.includes('/items'))).toBe(false);
    });
    it('surfaces an ABORTED run as an error too', async () => {
        const net = lifecycle({ finalStatus: 'ABORTED' });
        const client = new ApifyClient('token', 'live', { fetchImpl: net.impl, sleep: immediately });
        await expect(client.runProfilePosts(input)).rejects.toThrow(/ended ABORTED/);
    });
    it('aborts the run and raises a clear error when the poll budget is exhausted', async () => {
        const net = lifecycle({ finalStatus: 'SUCCEEDED', pollsBeforeTerminal: 99 });
        const clock = [0, 10000000];
        let tick = 0;
        const client = new ApifyClient('token', 'live', {
            fetchImpl: net.impl,
            sleep: immediately,
            now: () => clock[Math.min(tick++, clock.length - 1)] ?? 0,
        });
        await expect(client.runProfilePosts(input)).rejects.toThrow(/exceeded 600000ms/);
        expect(net.calls.some((c) => c.url.endsWith('/v2/actor-runs/run-1/abort'))).toBe(true);
    });
    it('reports a non-array dataset as drift rather than as zero results', async () => {
        const net = fakeFetch((url) => {
            if (url.includes('/v2/acts/')) {
                return json({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } });
            }
            if (url.includes('/items'))
                return json({ unexpected: 'object' });
            throw new Error(`unexpected url: ${url}`);
        });
        const client = new ApifyClient('token', 'live', { fetchImpl: net.impl, sleep: immediately });
        await expect(client.runProfilePosts(input)).rejects.toThrow(/did not return an array/);
    });
    it('replay mode never touches the network', async () => {
        const net = noNetwork();
        const client = new ApifyClient('token', 'replay', { fetchImpl: net.impl, sleep: immediately });
        const run = await client.runProfilePosts({
            ...input,
            targetUrls: ['https://www.linkedin.com/in/no-such-slug-for-tests'],
        });
        expect(net.calls).toHaveLength(0);
        expect(run.effectiveMode).toBe('replay');
        expect(run.costUsd).toBe(0);
    });
});
describe('apollo people_match', () => {
    it('normalizes a live match and marks the mode it really ran in', async () => {
        const net = fakeFetch(() => json({
            person: {
                first_name: 'Jordan',
                last_name: 'Example',
                email: 'Jordan@sample-services.example',
                email_status: 'verified',
                title: 'Founder',
                organization: { name: 'Sample Services', primary_domain: 'sample-services.example', estimated_num_employees: 14 },
            },
        }));
        const client = new ApolloClient('key', 'live', { fetchImpl: net.impl });
        const person = await client.peopleMatchByLinkedIn('https://www.linkedin.com/in/alex-example');
        expect(person.matched).toBe(true);
        expect(person.email).toBe('jordan@sample-services.example');
        expect(person.companyDomain).toBe('sample-services.example');
        expect(person.effectiveMode).toBe('live');
        expect(net.calls[0]?.url).toContain('/api/v1/people/match');
    });
    it('treats a hollow placeholder person (id + echoed URL, every fact null) as NO match', async () => {
        const net = fakeFetch(() => json({
            person: {
                id: '6a9871121bcf9c001c5432ab',
                name: 'Casey Example',
                first_name: 'Carlo',
                last_name: 'Viray',
                title: null,
                email: null,
                organization: null,
                employment_history: [],
                linkedin_url: 'http://www.linkedin.com/in/casey-example-growth',
                revealed_for_current_team: true,
            },
        }));
        const client = new ApolloClient('key', 'live', { fetchImpl: net.impl });
        const person = await client.peopleMatchByLinkedIn('https://www.linkedin.com/in/casey-example-3489');
        expect(person.matched).toBe(false);
        expect(person.companyName).toBeNull();
        expect((person.raw as {
            placeholder?: boolean;
        }).placeholder).toBe(true);
    });
    it('sends the name and a VERIFIED employer as matcher hints, never a bare URL', async () => {
        const net = fakeFetch(() => json({ person: { first_name: 'Jordan', last_name: 'Example', organization: { name: 'Sample Services' } } }));
        const client = new ApolloClient('key', 'live', { fetchImpl: net.impl });
        await client.peopleMatchByLinkedIn('https://www.linkedin.com/in/alex-example', { name: 'Alex Example', companyName: 'Sample Services' });
        const body = JSON.parse(net.calls[0]?.body ?? '{}') as Record<string, unknown>;
        expect(body.name).toBe('Alex Example');
        expect(body.organization_name).toBe('Sample Services');
        expect(body.linkedin_url).toContain('alex-example');
    });
    it('still marks 429 as retryable rather than degrading it away', async () => {
        const net = fakeFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }));
        const client = new ApolloClient('key', 'live', { fetchImpl: net.impl });
        await expect(client.peopleMatchByLinkedIn('https://www.linkedin.com/in/alex-example')).rejects.toMatchObject({ retryable: true, retryAfter: 30 });
    });
});
describe('heyreach client-side ramp cap', () => {
    const req = {
        linkedinUrl: 'https://www.linkedin.com/in/alex-example',
        message: 'A plain and specific opening.',
        kind: 'dm' as const,
        campaignId: 'camp-1',
        linkedInAccountId: '1001',
        correlationId: 'li-t9',
    };
    const now = new Date('2026-08-15T12:00:00.000Z');
    it('refuses a DM that would exceed the cap for today, and transmits nothing', async () => {
        const net = noNetwork();
        const client = new HeyReachClient('key', 'live', { fetchImpl: net.impl });
        const result = await client.send(req, { now, sentToday: { dms: 15, connects: 0 } });
        expect(net.calls).toHaveLength(0);
        expect(result.dispatched).toBe(false);
        expect(result.dryRun).toBe(true);
        expect(result.providerMessageId).toBeNull();
        expect(result.reason).toMatch(/DM ramp cap reached \(15\/15 today, week1\)/);
    });
    it('refuses an invite over the invite cap on its own counter', async () => {
        const net = noNetwork();
        const client = new HeyReachClient('key', 'live', { fetchImpl: net.impl });
        const result = await client.send({ ...req, kind: 'connect' }, { now, sentToday: { dms: 0, connects: 10 } });
        expect(net.calls).toHaveLength(0);
        expect(result.dispatched).toBe(false);
        expect(result.reason).toMatch(/invite ramp cap reached \(10\/10 today, week1\)/);
    });
    it('lets a send through when it is under the cap', async () => {
        const net = fakeFetch(() => json({ addedLeadsCount: 1, failedLeadsCount: 0, leadId: 'lead-9' }));
        const client = new HeyReachClient('key', 'live', { fetchImpl: net.impl });
        const result = await client.send(req, { now, sentToday: { dms: 14, connects: 0 } });
        expect(result.dispatched).toBe(true);
        expect(result.dryRun).toBe(false);
        expect(result.providerMessageId).toBe('lead-9');
        expect(net.calls[0]?.url).toContain('/campaign/AddLeadsToCampaignV2');
        expect(net.calls[0]?.body).toContain('li-t9');
        const sent = JSON.parse(net.calls[0]?.body ?? '{}') as {
            accountLeadPairs: Array<{
                linkedInAccountId: number;
                lead: {
                    customUserFields: Array<{
                        name: string;
                    }>;
                };
            }>;
        };
        expect(sent.accountLeadPairs[0]?.linkedInAccountId).toBe(1001);
        expect(sent.accountLeadPairs[0]?.lead.customUserFields.map((f) => f.name)).toEqual(['correlationId', 'touchKind', 'message']);
    });
    it('refuses to dispatch without a seat id — V2 binds every lead to a sender', async () => {
        const net = noNetwork();
        const client = new HeyReachClient('key', 'live', { fetchImpl: net.impl });
        const result = await client.send({ ...req, linkedInAccountId: '' });
        expect(net.calls).toHaveLength(0);
        expect(result.dispatched).toBe(false);
        expect(result.reason).toContain('HEYREACH_LINKEDIN_ACCOUNT_ID');
    });
    it('treats a V2 refusal (failedLeadsCount) as an error, never a silent sent', async () => {
        const net = fakeFetch(() => json({ addedLeadsCount: 0, updatedLeadsCount: 0, failedLeadsCount: 1 }));
        const client = new HeyReachClient('key', 'live', { fetchImpl: net.impl });
        await expect(client.send(req)).rejects.toThrow(/did not confirm/);
    });
    it('accepts a V2 count response as dispatched', async () => {
        const net = fakeFetch(() => json({ addedLeadsCount: 1, updatedLeadsCount: 0, failedLeadsCount: 0 }));
        const client = new HeyReachClient('key', 'live', { fetchImpl: net.impl });
        const result = await client.send(req);
        expect(result.dispatched).toBe(true);
        expect(result.providerMessageId).toBeNull();
    });
    it('does not enforce a cap it was never given counts for', async () => {
        const net = fakeFetch(() => json({ addedLeadsCount: 1, failedLeadsCount: 0, leadId: 'lead-10' }));
        const client = new HeyReachClient('key', 'live', { fetchImpl: net.impl });
        const result = await client.send(req);
        expect(result.dispatched).toBe(true);
    });
    it('keeps refusing an over-length connection note before anything else', async () => {
        const net = noNetwork();
        const client = new HeyReachClient('key', 'live', { fetchImpl: net.impl });
        const result = await client.send({ ...req, kind: 'connect', message: 'x'.repeat(301) });
        expect(net.calls).toHaveLength(0);
        expect(result.dispatched).toBe(false);
        expect(result.reason).toMatch(/caps it at 300/);
    });
    it('a non-live client still prints instead of posting', async () => {
        const net = noNetwork();
        const client = new HeyReachClient('key', 'dry_run', { fetchImpl: net.impl });
        const result = await client.send(req, { now, sentToday: { dms: 0, connects: 0 } });
        expect(net.calls).toHaveLength(0);
        expect(result.dispatched).toBe(false);
        expect(result.reason).toMatch(/dry run/);
    });
});
describe('mapVerifyResult', () => {
    it('maps every documented provider code onto our vocabulary', () => {
        expect(mapVerifyResult({ result: 'ok' })).toBe('good');
        expect(mapVerifyResult({ result: 'catch_all' })).toBe('catchall');
        expect(mapVerifyResult({ result: 'catchall' })).toBe('catchall');
        expect(mapVerifyResult({ result: 'unknown' })).toBe('risky');
        expect(mapVerifyResult({ result: 'disposable' })).toBe('risky');
        expect(mapVerifyResult({ result: 'invalid' })).toBe('invalid');
        expect(mapVerifyResult({ result: 'error' })).toBe('unverified');
        expect(mapVerifyResult({ result: 'timeout' })).toBe('unverified');
    });
    it('is case- and whitespace-insensitive', () => {
        expect(mapVerifyResult({ result: '  OK ' })).toBe('good');
        expect(mapVerifyResult({ result: 'Catch_All' })).toBe('catchall');
    });
    it('accepts a bare result string as well as the whole response body', () => {
        expect(mapVerifyResult('ok')).toBe('good');
        expect(mapVerifyResult('invalid')).toBe('invalid');
    });
    it('treats an UNKNOWN code as unverified rather than inventing a verdict', () => {
        expect(mapVerifyResult({ result: 'quantum_uncertain' })).toBe('unverified');
        expect(mapVerifyResult({ result: '' })).toBe('unverified');
        expect(mapVerifyResult({})).toBe('unverified');
        expect(mapVerifyResult(null)).toBe('unverified');
        expect(mapVerifyResult(undefined)).toBe('unverified');
        expect(mapVerifyResult({ result: 42 })).toBe('unverified');
    });
});
describe('millionverifier client', () => {
    it('sends the key and the address, and maps the verdict', async () => {
        const net = fakeFetch(() => json({ result: 'ok', email: 'jordan@sample-services.example' }));
        const client = new MillionVerifierClient('secret-key', 'live', { fetchImpl: net.impl });
        const result = await client.verify('jordan@sample-services.example');
        expect(result.status).toBe('good');
        expect(result.providerResult).toBe('ok');
        expect(result.effectiveMode).toBe('live');
        expect(result.costUsd).toBeGreaterThan(0);
        expect(net.calls[0]?.url).toContain('/api/v3/');
        expect(net.calls[0]?.url).toContain('email=jordan%40sample-services.example');
        expect(net.calls[0]?.url).toContain('timeout=20');
    });
    it('an HTTP error is "we do not know", not a bad address', async () => {
        const net = fakeFetch(() => new Response('nope', { status: 500 }));
        const client = new MillionVerifierClient('secret-key', 'live', { fetchImpl: net.impl });
        const result = await client.verify('jordan@sample-services.example');
        expect(result.status).toBe('unverified');
        expect(result.costUsd).toBe(0);
        expect(result.reason).toMatch(/HTTP 500/);
    });
    it('a transport failure degrades instead of crashing the enrich run', async () => {
        const net = fakeFetch(() => {
            throw new Error('ECONNRESET');
        });
        const client = new MillionVerifierClient('secret-key', 'live', { fetchImpl: net.impl });
        const result = await client.verify('jordan@sample-services.example');
        expect(result.status).toBe('unverified');
        expect(result.reason).toMatch(/ECONNRESET/);
    });
    it('dry-run mode performs no verification at all', async () => {
        const net = noNetwork();
        const client = new MillionVerifierClient('secret-key', 'dry_run', { fetchImpl: net.impl });
        const result = await client.verify('jordan@sample-services.example');
        expect(net.calls).toHaveLength(0);
        expect(result.status).toBe('unverified');
        expect(result.costUsd).toBe(0);
    });
});
