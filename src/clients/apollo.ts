import { config, type RunMode } from '../../config/index.js';
import { logger } from '../lib/log.js';
import { normalizeDomain, normalizeEmail } from '../lib/identity.js';
import { fixtureKey, readFixture, writeFixture } from './fixtures.js';
import type { FetchLike } from './apify.js';
const log = logger('apollo');
export interface ApolloPerson {
    matched: boolean;
    email: string | null;
    emailStatus: string | null;
    firstName: string | null;
    lastName: string | null;
    title: string | null;
    companyName: string | null;
    companyDomain: string | null;
    companyEmployees: number | null;
    companyIndustry: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    raw: unknown;
    costUsd: number;
    effectiveMode?: RunMode;
    degradedReason?: string | null;
}
const EMPTY: Omit<ApolloPerson, 'costUsd'> = {
    matched: false,
    email: null,
    emailStatus: null,
    firstName: null,
    lastName: null,
    title: null,
    companyName: null,
    companyDomain: null,
    companyEmployees: null,
    companyIndustry: null,
    city: null,
    state: null,
    country: null,
    raw: null,
};
export interface ApolloDeps {
    fetchImpl?: FetchLike;
}
export class ApolloClient {
    private readonly fetchImpl: FetchLike;
    constructor(private readonly apiKey: string = config.enrich.apolloKey, private readonly mode: RunMode = config.enrich.mode, deps: ApolloDeps = {}) {
        this.fetchImpl = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    }
    get runMode(): RunMode {
        return this.mode;
    }
    get degraded(): boolean {
        return (this.mode === 'live' || this.mode === 'capture') && !this.apiKey;
    }
    async peopleMatchByLinkedIn(linkedinUrl: string, hints: {
        name?: string | null;
        companyName?: string | null;
    } = {}): Promise<ApolloPerson> {
        const key = fixtureKey('apollo-people-match', linkedinUrl);
        if (this.mode === 'dry_run') {
            return {
                ...EMPTY,
                matched: false,
                raw: { dry_run: true, linkedinUrl },
                costUsd: 0,
                effectiveMode: 'dry_run',
                degradedReason: null,
            };
        }
        if (this.mode === 'replay') {
            const cached = await readFixture<unknown>(key);
            if (!cached) {
                return { ...EMPTY, raw: { replay_miss: key }, costUsd: 0, effectiveMode: 'replay', degradedReason: null };
            }
            return { ...normalizeApollo(cached), costUsd: 0, effectiveMode: 'replay', degradedReason: null };
        }
        if (!this.apiKey) {
            const reason = 'APOLLO_API_KEY absent — no live call was made';
            log.warn('DEGRADED to offline: APOLLO_API_KEY is not set', {
                configuredMode: this.mode,
                linkedinUrl,
            });
            return {
                ...EMPTY,
                raw: { degraded: reason, linkedinUrl },
                costUsd: 0,
                effectiveMode: 'dry_run',
                degradedReason: reason,
            };
        }
        const res = await this.fetchImpl(`${config.enrich.apolloBaseUrl}/api/v1/people/match`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': this.apiKey,
            },
            body: JSON.stringify({
                linkedin_url: linkedinUrl,
                ...(hints.name?.trim() ? { name: hints.name.trim() } : {}),
                ...(hints.companyName?.trim() ? { organization_name: hints.companyName.trim() } : {}),
                reveal_personal_emails: false,
            }),
        });
        if (res.status === 429 || res.status >= 500) {
            const err = new Error(`apollo transient ${res.status}`) as Error & {
                retryable: boolean;
                retryAfter?: number;
            };
            err.retryable = true;
            const header = res.headers.get('retry-after');
            if (header)
                err.retryAfter = Number(header);
            throw err;
        }
        if (!res.ok)
            throw new Error(`apollo people/match failed: ${res.status}`);
        const body = await res.json();
        if (this.mode === 'capture') {
            await writeFixture(key, body);
            log.info('captured apollo fixture', { key });
        }
        return {
            ...normalizeApollo(body),
            costUsd: config.enrich.costPerCreditUsd,
            effectiveMode: this.mode,
            degradedReason: null,
        };
    }
    async authHealth(): Promise<{
        ok: boolean;
        detail: string;
    }> {
        if (!this.apiKey)
            return { ok: false, detail: 'APOLLO_API_KEY absent' };
        const res = await this.fetchImpl(`${config.enrich.apolloBaseUrl}/api/v1/auth/health`, {
            headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok)
            return { ok: false, detail: `HTTP ${res.status}` };
        const body = (await res.json().catch(() => null)) as {
            is_logged_in?: boolean;
        } | null;
        if (body && body.is_logged_in === false)
            return { ok: false, detail: 'key rejected (is_logged_in=false)' };
        return { ok: true, detail: 'key accepted' };
    }
}
export function normalizeApollo(body: unknown): Omit<ApolloPerson, 'costUsd'> {
    const person = (body as {
        person?: Record<string, unknown>;
    } | null)?.person;
    if (!person)
        return { ...EMPTY, raw: body };
    const org = (person.organization ?? {}) as Record<string, unknown>;
    const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const asNumber = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const history = Array.isArray(person.employment_history) ? person.employment_history : [];
    const substance = asString(person.title) ??
        asString(person.email) ??
        asString(org.name) ??
        asString(org.primary_domain) ??
        asString(person.organization_name) ??
        (history.length > 0 ? 'employment_history' : null);
    if (!substance)
        return { ...EMPTY, raw: { placeholder: true, body } };
    return {
        matched: true,
        email: normalizeEmail(asString(person.email)),
        emailStatus: asString(person.email_status),
        firstName: asString(person.first_name),
        lastName: asString(person.last_name),
        title: asString(person.title),
        companyName: asString(org.name) ?? asString(person.organization_name),
        companyDomain: normalizeDomain(asString(org.website_url) ?? asString(org.primary_domain)),
        companyEmployees: asNumber(org.estimated_num_employees),
        companyIndustry: asString(org.industry),
        city: asString(person.city),
        state: asString(person.state),
        country: asString(person.country),
        raw: body,
    };
}
