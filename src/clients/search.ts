import { config, type RunMode } from '../../config/index.js';
import { fixtureKey, readFixture, writeFixture } from './fixtures.js';
export interface SearchHit {
    title: string;
    link: string;
    snippet: string;
}
export interface SearchResponse {
    hits: SearchHit[];
    costUsd: number;
    provider: string;
}
export interface SearchProvider {
    readonly name: string;
    search(query: string): Promise<SearchResponse>;
}
export class SerperProvider implements SearchProvider {
    readonly name = 'serper';
    constructor(private readonly apiKey: string = config.verify.serperKey, private readonly mode: RunMode = config.verify.mode) { }
    async search(query: string): Promise<SearchResponse> {
        const key = fixtureKey('search', query);
        if (this.mode === 'dry_run') {
            const asserted = /\b([a-z0-9-]+\.(?:io|com|ai|co|net|tech|us|dev))\b/i.exec(query)?.[1];
            if (!asserted)
                return { hits: [], costUsd: 0, provider: `${this.name}:dry_run` };
            return {
                hits: [
                    {
                        title: `DRY RUN — no search was performed (${asserted} asserted by the prospect)`,
                        link: `https://${asserted.toLowerCase()}`,
                        snippet: 'Synthetic offline result. Not evidence. Re-verify before any real send.',
                    },
                ],
                costUsd: 0,
                provider: `${this.name}:dry_run`,
            };
        }
        if (this.mode === 'replay') {
            const cached = await readFixture<{
                organic?: SearchHit[];
            }>(key);
            return { hits: cached?.organic ?? [], costUsd: 0, provider: `${this.name}:replay` };
        }
        if (!this.apiKey)
            throw new Error('SERPER_API_KEY is not set — cannot verify in live mode');
        const res = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-API-KEY': this.apiKey },
            body: JSON.stringify({ q: query, num: 10 }),
        });
        if (!res.ok)
            throw new Error(`serper failed: ${res.status}`);
        const body = (await res.json()) as {
            organic?: SearchHit[];
        };
        if (this.mode === 'capture')
            await writeFixture(key, body);
        return {
            hits: body.organic ?? [],
            costUsd: config.verify.costPerSearchUsd,
            provider: this.name,
        };
    }
}
export class StaticSearchProvider implements SearchProvider {
    readonly name = 'static';
    constructor(private readonly table: Record<string, SearchHit[]>) { }
    async search(query: string): Promise<SearchResponse> {
        return { hits: this.table[query] ?? [], costUsd: 0, provider: this.name };
    }
}
