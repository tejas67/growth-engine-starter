import { config } from '../../config/index.js';
import type { ApolloClient, ApolloPerson } from '../clients/apollo.js';
import type { VerifyStatus } from '../clients/millionverifier.js';
import { assessGov } from '../guardrails/gov_gate.js';
import { normalizeDomain, normalizeEmail } from '../lib/identity.js';
import { logger } from '../lib/log.js';
const log = logger('enrich');
export function mapApolloEmailStatus(raw: string | null | undefined): VerifyStatus {
    switch ((raw ?? '').trim().toLowerCase()) {
        case 'verified':
            return 'good';
        case 'guessed':
        case 'extrapolated':
            return 'risky';
        case 'bounced':
        case 'invalid':
            return 'invalid';
        case 'unavailable':
        case 'pending_manual_fulfillment':
        case '':
            return 'unverified';
        default:
            return 'unverified';
    }
}
export interface EnrichTarget {
    prospectId: number;
    linkedinUrl: string;
    fullName: string | null;
    headline: string | null;
    companyName: string | null;
    companyDomain: string | null;
    companyVerified: boolean;
    email: string | null;
}
export interface EnrichOutcome {
    prospectId: number;
    matched: boolean;
    patch: {
        email: string | null;
        emailVerifyStatus: string | null;
        companyName: string | null;
        companyDomain: string | null;
        isGov: boolean;
        govReason: string | null;
    };
    firmographics: Record<string, unknown> | null;
    costUsd: number;
    rescoreNeeded: boolean;
    note: string;
}
export function planEnrichment(target: EnrichTarget, person: ApolloPerson): EnrichOutcome {
    if (!person.matched) {
        return {
            prospectId: target.prospectId,
            matched: false,
            patch: {
                email: null,
                emailVerifyStatus: null,
                companyName: null,
                companyDomain: null,
                isGov: false,
                govReason: null,
            },
            firmographics: null,
            costUsd: person.costUsd,
            rescoreNeeded: false,
            note: 'no Apollo match — prospect stays DM-only (no_proof)',
        };
    }
    const email = normalizeEmail(person.email);
    const apolloDomain = normalizeDomain(person.companyDomain);
    const companyDomain = target.companyVerified ? target.companyDomain : (target.companyDomain ?? apolloDomain);
    const companyName = target.companyName ?? person.companyName;
    const gov = assessGov({
        email,
        employer: person.companyName,
        headline: target.headline,
        title: person.title,
    });
    const firmographics: Record<string, unknown> = {
        apollo_email_status: person.emailStatus,
        title: person.title,
        company_name: person.companyName,
        company_domain: apolloDomain,
        employees: person.companyEmployees,
        industry: person.companyIndustry,
        city: person.city,
        state: person.state,
        country: person.country,
    };
    const domainConflict = target.companyVerified && apolloDomain && target.companyDomain && apolloDomain !== target.companyDomain;
    if (domainConflict) {
        firmographics.domain_conflict = { verified: target.companyDomain, apollo: apolloDomain };
        log.warn('apollo domain disagrees with verified domain — keeping verified', {
            prospectId: target.prospectId,
            verified: target.companyDomain,
            apollo: apolloDomain,
        });
    }
    return {
        prospectId: target.prospectId,
        matched: true,
        patch: {
            email: target.email ?? email,
            emailVerifyStatus: target.email ? null : mapApolloEmailStatus(person.emailStatus),
            companyName,
            companyDomain,
            isGov: gov.isGov,
            govReason: gov.isGov ? gov.reason : null,
        },
        firmographics,
        costUsd: person.costUsd,
        rescoreNeeded: Boolean(person.companyEmployees || person.companyIndustry || apolloDomain),
        note: domainConflict ? 'enriched (domain conflict recorded, verified domain kept)' : 'enriched',
    };
}
export interface EnrichBudget {
    creditsUsedToday: number;
    cap: number;
}
export function enrichBudgetRemaining(budget: EnrichBudget): number {
    return Math.max(0, budget.cap - budget.creditsUsedToday);
}
export function hitRate(attempts: number, matches: number): {
    rate: number;
    belowFloor: boolean;
} {
    if (attempts === 0)
        return { rate: 0, belowFloor: false };
    const rate = matches / attempts;
    return { rate, belowFloor: rate < config.enrich.hitRateFloor };
}
export async function enrichOne(target: EnrichTarget, apollo: ApolloClient): Promise<EnrichOutcome> {
    const person = await apollo.peopleMatchByLinkedIn(target.linkedinUrl, {
        name: target.fullName,
        companyName: target.companyVerified ? target.companyName : null,
    });
    return planEnrichment(target, person);
}
