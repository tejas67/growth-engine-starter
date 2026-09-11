import { describe, expect, it } from 'vitest';
import { ApifyClient, buildPostsInput, buildReactionsInput, targetKey } from '../src/clients/apify.js';
const KROGER = 'https://www.linkedin.com/in/blair-example';
const POST_URL = 'https://www.linkedin.com/posts/riley_if-you-want-to-win-government-contracts-activity-9000000000000000001-lgcn';
describe('posts actor input', () => {
    it('is exactly the documented contract for a routine seed poll', () => {
        expect(buildPostsInput({ targetUrls: [KROGER] })).toEqual({
            targetUrls: ['https://www.linkedin.com/in/blair-example'],
            maxPosts: 5,
            postedLimit: 'week',
            includeReposts: true,
            includeQuotePosts: true,
            scrapeReactions: false,
            maxReactions: 0,
            scrapeComments: true,
            maxComments: 30,
            commentsPostedLimit: 'week',
            contextCountry: 'US',
        });
    });
    it('takes URLs, not slugs — and never emits the four invented fields', () => {
        const input = buildPostsInput({ targetUrls: [KROGER] }) as unknown as Record<string, unknown>;
        expect(input.targetUrls).toEqual([KROGER]);
        for (const dead of ['profiles', 'includeReactions', 'includeComments', 'limit']) {
            expect(input).not.toHaveProperty(dead);
        }
    });
    it('sends postedLimit as an ENUM STRING — the exact field that 400ed', () => {
        const input = buildPostsInput({ targetUrls: [KROGER] });
        expect(typeof input.postedLimit).toBe('string');
        expect(input.postedLimit).toBe('week');
        expect(typeof input.maxPosts).toBe('number');
    });
    it('widens the window on a seed we have never polled', () => {
        expect(buildPostsInput({ targetUrls: [KROGER], postedLimit: 'month' }).postedLimit).toBe('month');
    });
    it('buys comments and not reactions, by default', () => {
        const input = buildPostsInput({ targetUrls: [KROGER] });
        expect(input.scrapeReactions).toBe(false);
        expect(input.maxReactions).toBe(0);
        expect(input.scrapeComments).toBe(true);
        expect(input.maxComments).toBe(30);
        expect(input.commentsPostedLimit).toBe('week');
    });
    it('keeps reposts and quote posts — excluding them makes repost-heavy seeds look dead', () => {
        const input = buildPostsInput({ targetUrls: [KROGER] });
        expect(input.includeReposts).toBe(true);
        expect(input.includeQuotePosts).toBe(true);
    });
    it('omits postedLimitDate unless one is asked for', () => {
        expect(buildPostsInput({ targetUrls: [KROGER] })).not.toHaveProperty('postedLimitDate');
        expect(buildPostsInput({ targetUrls: [KROGER], postedLimitDate: '2026-08-01T00:00:00Z' })
            .postedLimitDate).toBe('2026-08-01T00:00:00Z');
    });
    it('takes a company URL through the same contract — the two actors share an input', () => {
        const input = buildPostsInput({ targetUrls: ['https://www.linkedin.com/company/sample-agency-two/'] });
        expect(input.targetUrls).toEqual(['https://www.linkedin.com/company/sample-agency-two/']);
    });
});
describe('reactions actor input', () => {
    it('is exactly the documented contract', () => {
        expect(buildReactionsInput({ postUrls: [POST_URL] })).toEqual({
            posts: [POST_URL],
            maxItems: 100,
            profileScraperMode: 'main',
        });
    });
    it('defaults to main mode — the only mode that yields an addressable identity', () => {
        expect(buildReactionsInput({ postUrls: [POST_URL] }).profileScraperMode).toBe('main');
    });
    it('never emits the invented `postUrl` / `limit` fields', () => {
        const input = buildReactionsInput({ postUrls: [POST_URL] }) as unknown as Record<string, unknown>;
        expect(input).not.toHaveProperty('postUrl');
        expect(input).not.toHaveProperty('limit');
        expect(input.posts).toEqual([POST_URL]);
    });
    it('omits reactionTypeFilter unless one is given', () => {
        expect(buildReactionsInput({ postUrls: [POST_URL] })).not.toHaveProperty('reactionTypeFilter');
        expect(buildReactionsInput({ postUrls: [POST_URL], reactionTypeFilter: ['LIKE'] }).reactionTypeFilter).toEqual(['LIKE']);
    });
});
describe('what actually crosses the wire', () => {
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    function capture(): {
        impl: (u: string, i?: RequestInit) => Promise<Response>;
        bodies: string[];
    } {
        const bodies: string[] = [];
        return {
            bodies,
            impl: async (url, init) => {
                if (init?.method === 'POST' && url.includes('/v2/acts/')) {
                    bodies.push(String(init.body));
                    return json({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } });
                }
                if (url.includes('/items'))
                    return json([]);
                return json({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } });
            },
        };
    }
    it('posts the mapper output verbatim and nothing else', async () => {
        const net = capture();
        const client = new ApifyClient('token', 'live', {
            fetchImpl: net.impl,
            sleep: async () => undefined,
        });
        const input = buildPostsInput({ targetUrls: [KROGER] });
        await client.runProfilePosts(input);
        expect(net.bodies).toHaveLength(1);
        expect(JSON.parse(net.bodies[0]!)).toEqual(input);
        expect(net.bodies[0]).not.toContain('"postedLimit":10');
        expect(net.bodies[0]).toContain('"postedLimit":"week"');
    });
    it('posts the reactions contract verbatim too', async () => {
        const net = capture();
        const client = new ApifyClient('token', 'live', {
            fetchImpl: net.impl,
            sleep: async () => undefined,
        });
        const input = buildReactionsInput({ postUrls: [POST_URL] });
        await client.runPostReactions(input);
        expect(JSON.parse(net.bodies[0]!)).toEqual(input);
    });
});
describe('fixture keys', () => {
    it('key on the TARGET, not on the tuning knobs', () => {
        expect(targetKey([KROGER])).toBe('blair-example');
        expect(targetKey(['https://www.linkedin.com/in/blair-example/'])).toBe('blair-example');
        expect(targetKey(['https://www.linkedin.com/company/sample-agency-two/'])).toBe('sample-agency-two');
    });
    it('reduce a post URL to its activity id, in either form', () => {
        expect(targetKey([POST_URL])).toBe('9000000000000000001');
        expect(targetKey(['https://www.linkedin.com/feed/update/urn:li:activity:9000000000000000001'])).toBe('9000000000000000001');
    });
});
