import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../config/index.js';
import { DailyCallBudget, UnipileClient, UnipileError } from '../src/clients/unipile.js';
import { cooldownUntil } from '../src/clients/unipile_ledger.js';
import { mapPostsPage, socialIdFor } from '../src/pipeline/schema/unipile.js';
import { resolvePost } from '../src/pipeline/scrape.js';
import { runUnipileScrape, type UnipileScrapeStore } from '../src/pipeline/scrape_unipile.js';
import { selectScrapeSource } from '../src/pipeline/scrape_source.js';
import { planUpgrade, orderResolveCandidates } from '../src/pipeline/resolve.js';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/unipile/${name}.json`, import.meta.url), 'utf8'));
const credentials = { dsn: 'https://example.test', apiKey: 'test', accountId: 'acct' };
afterEach(() => vi.restoreAllMocks());
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
describe('Unipile contracts', () => {
    it('keeps the source switch explicit', () => expect(selectScrapeSource('harvestapi')).toBe('harvestapi'));
    it('preserves a ugcPost URN that differs from the activity id', () => {
        expect(socialIdFor('9000000000000000004', 'urn:li:ugcPost:9000000000000000003')).toBe('urn:li:ugcPost:9000000000000000003');
        const mapped = mapPostsPage([{ id: '9000000000000000004', social_id: 'urn:li:ugcPost:9000000000000000003', text: 'test', parsed_datetime: '2026-09-09T00:00:00Z' }], { now: new Date(), seedSlug: 'sample-agency' });
        expect(resolvePost(mapped[0] as any, 'sample-agency')?.linkedinPostId).toBe('9000000000000000004');
    });
    it('reads connection status and follows reaction pagination', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(response(fixture('accounts')))
            .mockResolvedValueOnce(response(fixture('reactions-page-1'))).mockResolvedValueOnce(response(fixture('reactions-page-2')));
        const client = new UnipileClient(credentials, 'live', { fetchImpl: fetch, sleep: async () => { } });
        expect((await client.listAccounts())[0]?.id).toBeTruthy();
        expect((await client.listReactions('urn:li:activity:123', 1000)).data).toHaveLength(4);
        expect(String(fetch.mock.calls[2]?.[0])).toContain('cursor=cur_page2_abc');
    });
    it('reports schema drift instead of recording a successful empty scrape', async () => {
        const client = new UnipileClient(credentials, 'live', { fetchImpl: async () => response({ unexpected: [] }) });
        await expect(client.listPosts('x')).rejects.toThrow('missing items');
    });
    it('never calls out in dry mode and refuses exhausted call budgets', async () => {
        const fetch = vi.fn();
        const offline = new UnipileClient(credentials, 'dry_run', { fetchImpl: fetch });
        expect((await offline.listPosts('x')).data).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
        const client = new UnipileClient(credentials, 'live', { fetchImpl: fetch, ledger: new DailyCallBudget({ callsUsed: 1, callCap: 1, profilesUsed: 0, profileCap: 1 }) });
        await expect(client.listPosts('x')).rejects.toThrow('cap reached');
        expect(fetch).not.toHaveBeenCalled();
    });
    it('persists a 429 through the ledger and computes a UTC-day cooldown', async () => {
        const block = vi.fn();
        const client = new UnipileClient(credentials, 'live', { fetchImpl: async () => response({}, 429), ledger: { admit: () => ({ ok: true }), record: async () => { }, block } });
        await expect(client.listPosts('x')).rejects.toBeInstanceOf(UnipileError);
        expect(block).toHaveBeenCalledTimes(1);
        expect(cooldownUntil(new UnipileError('limit', 429), new Date('2026-09-09T23:50:00Z')).toISOString()).toBe('2026-09-10T00:00:00.000Z');
    });
    it('finishes identity with a public slug and keeps the internal alias', () => {
        const profile = { providerId: 'ACoAA00000000000000000000000000000000001', publicIdentifier: 'jo-smith' } as any;
        expect(planUpgrade('https://www.linkedin.com/in/' + profile.providerId, profile)).toMatchObject({ kind: 'resolved', slug: 'jo-smith' });
        const base = { linkedin_url: 'https://www.linkedin.com/in/' + profile.providerId, first_detected_at: new Date() };
        expect(orderResolveCandidates([{ ...base, id: 1, persona: 'P0', score: 99 }, { ...base, id: 2, persona: 'P1', score: 80 }]).map(r => r.id)).toEqual([2]);
    });
});
it('saves completed comment pages when reactions fail, then resumes without re-fetching comments', async () => {
    vi.spyOn(config.unipile, 'mode', 'get').mockReturnValue('live');
    const post = { id: 1, linkedin_post_id: '123', unipile_social_id: 'urn:li:ugcPost:456', posted_at: new Date(Date.now() - 3600000), last_scraped_at: null, unipile_poll_state: {} };
    const store = { listTrackedSeeds: async () => [], unitsToday: async () => 0, listPollablePosts: async () => [post],
        saveUnipilePollState: vi.fn(async (_id, state) => { post.unipile_poll_state = structuredClone(state); }),
        upsertProspect: vi.fn(async () => ({ id: 10, created: true })), insertEngagement: vi.fn(async () => true),
        recordSpend: vi.fn(), recordScrapeRun: vi.fn(), openHold: vi.fn(), markPostScraped: vi.fn() } as unknown as UnipileScrapeStore;
    const comments = fixture('comments-page');
    comments.paging = null;
    comments.cursor = null;
    const first = vi.fn().mockResolvedValueOnce(response(comments)).mockResolvedValueOnce(response({}, 429));
    const make = (fetch: any) => (ledger: any) => new UnipileClient(credentials, 'live', { fetchImpl: fetch, ledger, sleep: async () => { } });
    expect((await runUnipileScrape({ store, makeClient: make(first) })).stopped).toContain('429');
    expect(store.markPostScraped).not.toHaveBeenCalled();
    expect(post.unipile_poll_state).toMatchObject({ comments: { complete: true } });
    const second = vi.fn().mockResolvedValue(response({ items: [], cursor: null }));
    expect((await runUnipileScrape({ store, makeClient: make(second) })).postsPolled).toBe(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(String(second.mock.calls[0]?.[0])).toContain('reactions');
    expect(String(second.mock.calls[0]?.[0])).toContain('ugcPost%3A456');
});
it('keeps reading comments when posts and reactions exhaust their separate allowances', async () => {
    vi.spyOn(config.unipile, 'mode', 'get').mockReturnValue('live');
    const posts = [1, 2].map(id => ({ id, linkedin_post_id: String(id), posted_at: new Date(), last_scraped_at: null, unipile_poll_state: {} }));
    const store = { listTrackedSeeds: async () => [{ id: 1, slug: 'test', kind: 'person', unipile_provider_id: 'cached', last_scraped_at: null, cadence_class: 'active' }],
        unitsToday: async () => 0, listPollablePosts: async () => posts,
        saveUnipilePollState: vi.fn(), recordSpend: vi.fn(), recordScrapeRun: vi.fn(), openHold: vi.fn(), markPostScraped: vi.fn()
    } as unknown as UnipileScrapeStore;
    const admit = vi.fn(kind => ['posts', 'reactions'].includes(kind) ? { ok: false as const, reason: 'daily action cap' } : { ok: true as const });
    const fetch = vi.fn().mockImplementation(async () => response({ items: [], cursor: null }));
    const result = await runUnipileScrape({ store, makeClient: () => new UnipileClient(credentials, 'live', {
            fetchImpl: fetch, sleep: async () => { }, ledger: { admit, record: async () => { } }
        }) });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(call => String(call[0]).includes('comments'))).toBe(true);
    expect(admit.mock.calls.map(c => c[0])).toEqual(['posts', 'comments', 'reactions', 'comments']);
    expect(store.saveUnipilePollState).toHaveBeenCalledTimes(2);
    expect(store.markPostScraped).not.toHaveBeenCalled();
    expect(result.stopped).toBe('daily action cap');
});
