export type AliasKind = 'linkedin_url' | 'linkedin_slug' | 'email' | 'platform_person_uuid';
export interface Alias {
    kind: AliasKind;
    value: string;
}
export interface AliasRow extends Alias {
    prospectId: number;
}
export interface IdentityNode {
    id: number;
    canonicalProspectId: number | null;
}
const LINKEDIN_HOSTS = new Set([
    'linkedin.com',
    'www.linkedin.com',
    'm.linkedin.com',
    'ca.linkedin.com',
    'uk.linkedin.com',
]);
export function normalizeLinkedInUrl(input: string | null | undefined): string | null {
    if (!input)
        return null;
    let raw = input.trim();
    if (!raw)
        return null;
    if (!/^https?:\/\//i.test(raw))
        raw = `https://${raw}`;
    let url: URL;
    try {
        url = new URL(raw);
    }
    catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    if (!LINKEDIN_HOSTS.has(host) && !host.endsWith('.linkedin.com'))
        return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const kindIdx = segments.findIndex((s) => s === 'in' || s === 'company' || s === 'showcase');
    if (kindIdx === -1 || !segments[kindIdx + 1])
        return null;
    const kind = segments[kindIdx]!;
    const slug = decodeURIComponent(segments[kindIdx + 1]!).toLowerCase();
    if (!slug)
        return null;
    return `https://www.linkedin.com/${kind}/${slug}`;
}
export function linkedInSlug(input: string | null | undefined): string | null {
    const normalized = normalizeLinkedInUrl(input);
    if (!normalized)
        return null;
    const parts = normalized.split('/');
    return parts[parts.length - 1] ?? null;
}
export function isInternalProfileId(slug: string | null | undefined): boolean {
    if (!slug)
        return false;
    return /^acoa[a-z0-9_-]{16,}$/i.test(slug);
}
export function isInternalProfileUrl(url: string | null | undefined): boolean {
    return isInternalProfileId(linkedInSlug(url));
}
export function isCompanyPageUrl(input: string | null | undefined): boolean {
    const normalized = normalizeLinkedInUrl(input);
    return normalized !== null && (normalized.includes('/company/') || normalized.includes('/showcase/'));
}
export function normalizeEmail(input: string | null | undefined): string | null {
    if (!input)
        return null;
    const trimmed = input.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@'))
        return null;
    const [local, domain, ...rest] = trimmed.split('@');
    if (rest.length > 0 || !local || !domain || !domain.includes('.'))
        return null;
    return trimmed;
}
export function normalizeDomain(input: string | null | undefined): string | null {
    if (!input)
        return null;
    let raw = input.trim().toLowerCase();
    if (!raw)
        return null;
    raw = raw.replace(/^https?:\/\//, '').replace(/^www\./, '');
    const host = raw.split('/')[0]!.split('?')[0]!.split(':')[0]!;
    if (!host.includes('.') || host.endsWith('.'))
        return null;
    return host;
}
export function normalizeAlias(kind: AliasKind, value: string): string | null {
    switch (kind) {
        case 'linkedin_url':
            return normalizeLinkedInUrl(value);
        case 'linkedin_slug':
            return value.trim().toLowerCase() || null;
        case 'email':
            return normalizeEmail(value);
        case 'platform_person_uuid':
            return value.trim().toLowerCase() || null;
    }
}
export function resolveCanonicalId(nodes: Map<number, IdentityNode>, startId: number): number {
    const seen = new Set<number>();
    let current = startId;
    while (true) {
        if (seen.has(current))
            return Math.min(...seen);
        seen.add(current);
        const node = nodes.get(current);
        if (!node || node.canonicalProspectId === null || node.canonicalProspectId === current) {
            return current;
        }
        current = node.canonicalProspectId;
    }
}
export function resolveByAliases(aliasRows: AliasRow[], nodes: Map<number, IdentityNode>, probes: Alias[]): number[] {
    const index = new Map<string, number>();
    for (const row of aliasRows) {
        const norm = normalizeAlias(row.kind, row.value);
        if (norm)
            index.set(`${row.kind}:${norm}`, row.prospectId);
    }
    const hits = new Set<number>();
    for (const probe of probes) {
        const norm = normalizeAlias(probe.kind, probe.value);
        if (!norm)
            continue;
        const prospectId = index.get(`${probe.kind}:${norm}`);
        if (prospectId !== undefined)
            hits.add(resolveCanonicalId(nodes, prospectId));
    }
    return [...hits].sort((a, b) => a - b);
}
export interface MergePlan {
    winnerId: number;
    loserIds: number[];
    aliases: Alias[];
}
export function planMerge(aliasRows: AliasRow[], nodes: Map<number, IdentityNode>, probes: Alias[]): MergePlan | null {
    const canonicalIds = resolveByAliases(aliasRows, nodes, probes);
    if (canonicalIds.length === 0)
        return null;
    const winnerId = canonicalIds[0]!;
    const loserIds = canonicalIds.slice(1);
    const aliases: Alias[] = [];
    const seen = new Set<string>();
    const push = (kind: AliasKind, value: string) => {
        const norm = normalizeAlias(kind, value);
        if (!norm)
            return;
        const key = `${kind}:${norm}`;
        if (seen.has(key))
            return;
        seen.add(key);
        aliases.push({ kind, value: norm });
    };
    const affected = new Set(canonicalIds);
    for (const row of aliasRows) {
        if (affected.has(resolveCanonicalId(nodes, row.prospectId)))
            push(row.kind, row.value);
    }
    for (const probe of probes)
        push(probe.kind, probe.value);
    return { winnerId, loserIds, aliases };
}
export function companyKey(name: string | null, domain: string | null): string | null {
    const d = normalizeDomain(domain);
    if (d)
        return `domain:${d}`;
    if (!name)
        return null;
    const slug = name
        .toLowerCase()
        .replace(/\b(inc|llc|l\.l\.c|corp|corporation|co|ltd|limited|company)\b\.?/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug ? `name:${slug}` : null;
}
