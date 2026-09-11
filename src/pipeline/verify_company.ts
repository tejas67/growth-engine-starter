import { config } from '../../config/index.js';
import type { SearchProvider } from '../clients/search.js';
import { normalizeDomain } from '../lib/identity.js';
import { logger } from '../lib/log.js';
const log = logger('verify');
export type Verdict = 'verified' | 'contradicted' | 'inconclusive';
export interface VerificationResult {
    verdict: Verdict;
    verifiedDomain: string | null;
    summary: string;
    evidence: Array<{
        title: string;
        link: string;
        snippet: string;
    }>;
    costUsd: number;
    query: string;
    provider: string;
}
const NON_COMPANY_HOSTS = [
    'linkedin.com',
    'facebook.com',
    'twitter.com',
    'x.com',
    'instagram.com',
    'crunchbase.com',
    'bloomberg.com',
    'zoominfo.com',
    'rocketreach.co',
    'apollo.io',
    'glassdoor.com',
    'indeed.com',
    'wikipedia.org',
    'youtube.com',
    'medium.com',
    'github.com',
    'pitchbook.com',
    'dnb.com',
    'signalhire.com',
    'leadiq.com',
    'linktr.ee',
];
function isCompanyHost(link: string): boolean {
    const host = normalizeDomain(link);
    if (!host)
        return false;
    return !NON_COMPANY_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`));
}
export function hostMatchesName(host: string, companyName: string): boolean {
    const label = host.split('.')[0] ?? '';
    const compact = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hostCompact = label.replace(/[^a-z0-9]/g, '');
    if (!compact || !hostCompact)
        return false;
    return hostCompact.includes(compact) || compact.includes(hostCompact);
}
export interface VerifyInput {
    companyName: string;
    personName?: string | null;
    headline?: string | null;
    assertedDomain?: string | null;
}
export function buildQuery(input: VerifyInput): string {
    const bits = [input.companyName];
    if (input.assertedDomain)
        bits.push(input.assertedDomain);
    else
        bits.push('company');
    if (input.headline) {
        const words = input.headline
            .replace(/[|•]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 4 && !/^(founder|ceo|cto|coo|president|building)$/i.test(w))
            .slice(0, 3);
        bits.push(...words);
    }
    return bits.join(' ').trim();
}
export async function verifyCompany(input: VerifyInput, provider: SearchProvider): Promise<VerificationResult> {
    const query = buildQuery(input);
    const response = await provider.search(query);
    const base = {
        evidence: response.hits.slice(0, 5),
        costUsd: response.costUsd,
        query,
        provider: response.provider,
    };
    if (response.hits.length === 0) {
        return {
            ...base,
            verdict: 'inconclusive',
            verifiedDomain: null,
            summary: 'no search results — company identity unverified, prospect stays in the hold pool',
        };
    }
    const asserted = normalizeDomain(input.assertedDomain);
    if (asserted) {
        const hit = response.hits.find((h) => normalizeDomain(h.link) === asserted);
        if (hit) {
            return {
                ...base,
                verdict: 'verified',
                verifiedDomain: asserted,
                summary: `asserted domain ${asserted} confirmed by search: ${hit.title}`,
            };
        }
    }
    const candidates = response.hits.filter((h) => isCompanyHost(h.link));
    const named = candidates.filter((h) => {
        const host = normalizeDomain(h.link);
        return host ? hostMatchesName(host, input.companyName) : false;
    });
    if (named.length === 0) {
        return {
            ...base,
            verdict: 'inconclusive',
            verifiedDomain: null,
            summary: `no result host resembles "${input.companyName}" — cannot confirm which company this is`,
        };
    }
    const domains = new Set(named.map((h) => normalizeDomain(h.link)).filter(Boolean) as string[]);
    if (domains.size > 1) {
        return {
            ...base,
            verdict: 'inconclusive',
            verifiedDomain: null,
            summary: `ambiguous: ${[...domains].join(', ')} all plausibly match "${input.companyName}"`,
        };
    }
    const domain = [...domains][0]!;
    const top = named[0]!;
    log.debug('company verified', { company: input.companyName, domain });
    return {
        ...base,
        verdict: 'verified',
        verifiedDomain: domain,
        summary: `${domain} — ${top.title}: ${top.snippet.slice(0, 200)}`,
    };
}
export function verifyBudgetRemaining(spentToday: number): number {
    return Math.max(0, config.verify.dailyCap - spentToday);
}
