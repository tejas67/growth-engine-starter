import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readSettings, businessContext, projectRoot } from '../../config/local.js';
import { liveAiRunner } from '../clients/ai.js';
import { config } from '../../config/index.js';
import { asQuotedData, callStructured, ClaudeError, cliRunner, type ClaudeRunner, } from '../clients/claude.js';
import { inputHash } from '../lib/hash.js';
import { companyFromHeadline } from './scrape.js';
import { logger } from '../lib/log.js';
const log = logger('score');
const SKILL_PATH = join(projectRoot, 'skills/icp-scorer.md');
export const PERSONAS = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export type Persona = (typeof PERSONAS)[number];
export const SUBTYPES = [
    'P0-seller',
    'P0-competitor',
    'P0-geo',
    'P0-student',
    'P0-prime',
    'P0-seed-graph',
    'P0-author-colleague',
    'P0-company-page',
] as const;
export const AssessmentSchema = z.object({
    linkedin_url: z.string(),
    score: z.number().int().min(0).max(100),
    persona: z.enum(PERSONAS),
    persona_subtype: z.enum(SUBTYPES).nullable().optional(),
    company_guess: z.string().nullable().optional(),
    verification_required: z.boolean(),
    gov_signal: z.boolean(),
    hold: z.boolean(),
    hold_reason: z.string().nullable().optional(),
    reasoning: z.string().min(1),
});
const REASONING_ALIASES = ['reasoning', 'rationale', 'why', 'explanation', 'reason', 'notes'] as const;
const BOOL_FIELDS = ['verification_required', 'gov_signal', 'hold'] as const;
export function normalizeAssessment(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return raw;
    const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    if (typeof o.reasoning !== 'string' || o.reasoning.trim() === '') {
        for (const key of REASONING_ALIASES) {
            const v = o[key];
            if (typeof v === 'string' && v.trim() !== '') {
                o.reasoning = v.trim();
                break;
            }
        }
    }
    if ((typeof o.reasoning !== 'string' || o.reasoning.trim() === '') && typeof o.hold_reason === 'string' && o.hold_reason.trim() !== '') {
        o.reasoning = o.hold_reason.trim();
    }
    if (typeof o.score === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(o.score))
        o.score = Number(o.score);
    if (typeof o.score === 'number' && Number.isFinite(o.score)) {
        o.score = Math.max(0, Math.min(100, Math.round(o.score)));
    }
    for (const key of BOOL_FIELDS) {
        const v = o[key];
        if (v === undefined || v === null)
            o[key] = false;
        else if (v === 'true')
            o[key] = true;
        else if (v === 'false')
            o[key] = false;
    }
    if (typeof o.persona === 'string')
        o.persona = o.persona.trim().toUpperCase();
    if (typeof o.persona_subtype === 'string') {
        const sub = o.persona_subtype.trim();
        o.persona_subtype = (SUBTYPES as readonly string[]).includes(sub) ? sub : null;
    }
    if (typeof o.linkedin_url === 'string')
        o.linkedin_url = o.linkedin_url.trim();
    return o;
}
export const LenientAssessmentSchema = z.preprocess(normalizeAssessment, AssessmentSchema);
export const BatchSchema = z.object({ assessments: z.array(z.unknown()) });
export type RowHold = {
    candidate: ScoreCandidate;
    holdKind: 'malformed' | 'count_mismatch';
    detail: string;
};
export function validateAssessments(candidates: ScoreCandidate[], rows: unknown[]): {
    scored: Array<{
        candidate: ScoreCandidate;
        assessment: Assessment;
    }>;
    held: RowHold[];
} {
    const bySlug = new Map(candidates.map((c) => [slugOf(c.linkedinUrl), c] as const));
    const answered = new Map<string, {
        assessment?: Assessment;
        issues?: string;
    }>();
    for (const [i, row] of rows.entries()) {
        const url = row && typeof row === 'object' && typeof (row as {
            linkedin_url?: unknown;
        }).linkedin_url === 'string'
            ? (row as {
                linkedin_url: string;
            }).linkedin_url
            : null;
        const slug = url ? slugOf(url) : null;
        const candidate = slug ? bySlug.get(slug) : undefined;
        if (!candidate) {
            const positional = url === null && rows.length === candidates.length ? candidates[i] : undefined;
            if (!positional) {
                log.warn('assessment for unknown prospect dropped', { linkedin_url: url, index: i });
                continue;
            }
            const parsed = LenientAssessmentSchema.safeParse({ ...(row as object), linkedin_url: positional.linkedinUrl });
            answered.set(slugOf(positional.linkedinUrl), parsed.success ? { assessment: parsed.data } : { issues: issuesOf(parsed.error) });
            continue;
        }
        if (answered.has(slug!))
            continue;
        const parsed = LenientAssessmentSchema.safeParse(row);
        if (!parsed.success) {
            log.warn('assessment row failed validation', {
                linkedin_url: url,
                keys: Object.keys(row as object),
                issues: issuesOf(parsed.error),
            });
        }
        answered.set(slug!, parsed.success ? { assessment: parsed.data } : { issues: issuesOf(parsed.error) });
    }
    const scored: Array<{
        candidate: ScoreCandidate;
        assessment: Assessment;
    }> = [];
    const held: RowHold[] = [];
    for (const candidate of candidates) {
        const a = answered.get(slugOf(candidate.linkedinUrl));
        if (!a)
            held.push({ candidate, holdKind: 'count_mismatch', detail: `model returned no assessment (asked ${candidates.length}, got ${rows.length})` });
        else if (a.assessment)
            scored.push({ candidate, assessment: a.assessment });
        else
            held.push({ candidate, holdKind: 'malformed', detail: a.issues ?? 'schema validation failed' });
    }
    return { scored, held };
}
function issuesOf(err: z.ZodError): string {
    return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
export type Assessment = z.infer<typeof AssessmentSchema>;
export interface ScoreCandidate {
    prospectId: number;
    linkedinUrl: string;
    fullName: string | null;
    headline: string | null;
    location: string | null;
    countryClass: string;
    isCompanyPage: boolean;
    companyName: string | null;
    postAuthorSlug: string | null;
    postAuthorName: string | null;
    postExcerpt: string | null;
    engagementType: 'like' | 'comment';
    commentText: string | null;
    enrichment?: {
        title: string | null;
        companyName: string | null;
        companyDomain: string | null;
        employees: number | null;
        industry: string | null;
        email: string | null;
    } | null;
}
export interface PreFilterContext {
    seedSlugs: Set<string>;
    authorSlug: string | null;
    authorCompany: string | null;
}
export function slugOf(url: string): string {
    const path = (url.split('?')[0] ?? '').split('#')[0]?.replace(/\/+$/, '') ?? '';
    return (path.split('/').pop() ?? '').trim().toLowerCase();
}
export function resolveAuthorCompany(authorSlug: string | null | undefined, authorHeadline: string | null | undefined, seedCompanies: Map<string, string>): string | null {
    const slug = authorSlug?.trim().toLowerCase();
    if (slug) {
        const curated = seedCompanies.get(slug);
        if (curated)
            return curated;
    }
    return companyFromHeadline(authorHeadline);
}
export const PRIME_EMPLOYERS: readonly string[] = [];
const FORMER_MARKERS = /(?:\bex[- ]|\bformer(?:ly)?\b|\bprev(?:iously)?\b|\bretired\b|\balum(?:ni|nus)?\b|\bveteran of\b)\s*(?:the\s+)?$/i;
const FORMER_AFTER_MARKERS = /^\s*(?:\(?\s*(?:ret\.?|retired|former|formerly|alum(?:ni|nus)?|veteran)\b|alum(?:ni|nus)?\b|veteran\b)/i;
export function primeEmployerOf(text: string | null | undefined): string | null {
    if (!text)
        return null;
    const lower = text.toLowerCase();
    for (const prime of readSettings().business.excludedCompanies.map(value => value.toLowerCase())) {
        const re = new RegExp(`(^|[^a-z0-9])${prime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(lower)) !== null) {
            const start = m.index + (m[1] ?? '').length;
            const before = lower.slice(Math.max(0, m.index - 14), start);
            const after = lower.slice(start + prime.length, start + prime.length + 16);
            if (FORMER_MARKERS.test(before) || FORMER_AFTER_MARKERS.test(after))
                continue;
            return prime;
        }
    }
    return null;
}
export function preFilter(candidate: ScoreCandidate, ctx: PreFilterContext): Assessment | null {
    const slug = slugOf(candidate.linkedinUrl);
    const prime = primeEmployerOf(candidate.companyName) ?? primeEmployerOf(candidate.headline);
    if (prime) {
        return synthetic(candidate, 'P0-prime', `current employer is excluded by your business profile (${prime})`);
    }
    if (candidate.isCompanyPage) {
        return synthetic(candidate, 'P0-company-page', 'LinkedIn company page — company-level interest signal, not a person prospect');
    }
    if (ctx.seedSlugs.has(slug)) {
        return synthetic(candidate, 'P0-seed-graph', 'this person is one of our own seed accounts — seeds engage each other constantly');
    }
    if (ctx.authorSlug && slug === ctx.authorSlug) {
        return synthetic(candidate, 'P0-seed-graph', 'the post author');
    }
    if (ctx.authorCompany && candidate.headline) {
        const needle = ctx.authorCompany.toLowerCase();
        if (needle.length >= 3 && candidate.headline.toLowerCase().includes(needle)) {
            return synthetic(candidate, 'P0-author-colleague', `headline names the post author's own company (${ctx.authorCompany})`);
        }
    }
    return null;
}
function synthetic(candidate: ScoreCandidate, subtype: (typeof SUBTYPES)[number], reason: string): Assessment {
    return {
        linkedin_url: candidate.linkedinUrl,
        score: 0,
        persona: 'P0',
        persona_subtype: subtype,
        company_guess: candidate.companyName ?? null,
        verification_required: false,
        gov_signal: false,
        hold: false,
        hold_reason: null,
        reasoning: `deterministic exclusion: ${reason}`,
    };
}
export function buildPrompt(candidates: ScoreCandidate[]): string {
    const blocks = candidates.map((c, i) => {
        const parts = [
            `### Person ${i + 1}`,
            `linkedin_url: ${c.linkedinUrl}`,
            `name: ${c.fullName ?? '(unknown)'}`,
            `location_class: ${c.countryClass}`,
            `engagement: ${c.engagementType} on a post by ${c.postAuthorName ?? c.postAuthorSlug ?? '(unknown)'}`,
            asQuotedData('headline', c.headline),
            asQuotedData('location', c.location),
        ];
        if (c.commentText)
            parts.push(asQuotedData('their_comment', c.commentText));
        if (c.postExcerpt)
            parts.push(asQuotedData('post_they_engaged', c.postExcerpt));
        if (c.enrichment) {
            parts.push(asQuotedData('firmographics', [
                `title: ${c.enrichment.title ?? '-'}`,
                `company: ${c.enrichment.companyName ?? '-'}`,
                `domain: ${c.enrichment.companyDomain ?? '-'}`,
                `employees: ${c.enrichment.employees ?? '-'}`,
                `industry: ${c.enrichment.industry ?? '-'}`,
            ].join('\n')));
        }
        return parts.join('\n');
    });
    return [
        `Score the following ${candidates.length} people against the rubric.`,
        `Return {"assessments":[...]} with exactly ${candidates.length} objects, in the same order.`,
        '',
        ...blocks,
    ].join('\n\n');
}
export async function loadRubric(path = SKILL_PATH): Promise<string> {
    return (await readFile(path, 'utf8')) + '\n\n' + businessContext();
}
export type ScoreOutcome = {
    kind: 'scored';
    assessments: Array<{
        candidate: ScoreCandidate;
        assessment: Assessment;
    }>;
    held: RowHold[];
    attempts: number;
} | {
    kind: 'hold';
    reason: string;
    detail: string;
    holdKind: 'malformed' | 'refusal' | 'transport' | 'timeout' | 'rate_limit' | 'count_mismatch';
};
export async function scoreBatch(candidates: ScoreCandidate[], rubric: string, runner: ClaudeRunner, maxRetries = config.score.maxRetries): Promise<ScoreOutcome> {
    if (candidates.length === 0)
        return { kind: 'scored', assessments: [], held: [], attempts: 0 };
    try {
        const { value, attempts } = await callStructured(runner, BatchSchema, buildPrompt(candidates), rubric, maxRetries);
        const { scored, held } = validateAssessments(candidates, value.assessments);
        if (held.length > 0) {
            log.warn('scoring held rows', {
                held: held.length,
                scored: scored.length,
                sample: held.slice(0, 3).map((h) => ({ url: h.candidate.linkedinUrl, kind: h.holdKind, detail: h.detail })),
            });
        }
        return { kind: 'scored', assessments: scored, held, attempts };
    }
    catch (err) {
        if (err instanceof ClaudeError) {
            log.warn('scoring held', { kind: err.kind, message: err.message });
            return {
                kind: 'hold',
                holdKind: err.kind === 'malformed' ? 'malformed' : err.kind,
                reason: err.kind,
                detail: err.message,
            };
        }
        return {
            kind: 'hold',
            holdKind: 'transport',
            reason: 'transport',
            detail: (err as Error).message,
        };
    }
}
export function dryRunScoreRunner(): ClaudeRunner {
    return async (prompt: string) => {
        const urls = [...prompt.matchAll(/^linkedin_url: (\S+)$/gm)].map((m) => m[1]!);
        const headlines = [...prompt.matchAll(/<headline>\n([\s\S]*?)\n<\/headline>/g)].map((m) => m[1]!);
        const assessments = urls.map((url, i) => {
            const headline = (headlines[i] ?? '').toLowerCase();
            const founder = /\b(founder|co-founder|ceo|cto|chief technology)\b/.test(headline);
            const seller = /\b(consultant|proposal|coach|advisor|helping|staffing)\b/.test(headline);
            const bd = /\b(bd|business development|growth|capture|cro|vp )\b/.test(headline);
            const gov = /\b(air force|army|navy|federal cio|deputy chief|program control)\b/.test(headline);
            const persona = gov ? 'P4' : seller ? 'P0' : founder ? 'P1' : bd ? 'P3' : 'P2';
            const score = gov ? 55 : seller ? 20 : founder ? 78 : bd ? 68 : 45;
            return {
                linkedin_url: url,
                score,
                persona,
                persona_subtype: persona === 'P0' ? 'P0-seller' : null,
                company_guess: null,
                verification_required: true,
                gov_signal: gov,
                hold: false,
                hold_reason: null,
                reasoning: 'DRY RUN — no model was called. Heuristic label from the headline only; not a real assessment.',
            };
        });
        return JSON.stringify({ assessments });
    };
}
export function defaultRunner(): ClaudeRunner {
    if (config.score.mode !== 'live')
        return dryRunScoreRunner();
    return liveAiRunner();
}
export function candidateHash(candidate: ScoreCandidate, rubricVersion: string): string {
    return inputHash([
        rubricVersion,
        JSON.stringify(readSettings().business),
        candidate.linkedinUrl,
        candidate.headline,
        candidate.location,
        candidate.commentText,
        candidate.enrichment?.companyDomain,
        candidate.enrichment?.employees,
    ]);
}
