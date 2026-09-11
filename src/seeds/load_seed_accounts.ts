import { readFile } from 'node:fs/promises';
import { closeDb } from '../../db/client.js';
import { normalizeLinkedInUrl } from '../lib/identity.js';
import * as repo from '../repo/index.js';
export interface SeedRow {
    slug: string;
    kind: 'person' | 'company';
    displayName: string | null;
    linkedinUrl: string;
    tier: number;
    track: boolean;
    cadenceClass: 'active' | 'repost_heavy' | 'dormant' | 'unknown';
    notes: string | null;
    companyName: string | null;
}
export function splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') {
                current += '"';
                i++;
            }
            else if (ch === '"')
                inQuotes = false;
            else
                current += ch;
        }
        else if (ch === '"')
            inQuotes = true;
        else if (ch === ',') {
            out.push(current);
            current = '';
        }
        else
            current += ch;
    }
    out.push(current);
    return out.map((f) => f.trim());
}
const CADENCE = new Set(['active', 'repost_heavy', 'dormant', 'unknown']);
export function parseSeedCsv(text: string): {
    rows: SeedRow[];
    errors: string[];
} {
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0)
        return { rows: [], errors: ['empty file'] };
    const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
    const idx = (name: string): number => header.indexOf(name);
    const slugIdx = idx('slug');
    const kindIdx = idx('kind');
    if (slugIdx === -1 || kindIdx === -1) {
        return { rows: [], errors: ['CSV must have at least `slug` and `kind` columns'] };
    }
    const rows: SeedRow[] = [];
    const errors: string[] = [];
    for (let i = 1; i < lines.length; i++) {
        const fields = splitCsvLine(lines[i]!);
        const at = (name: string): string => {
            const j = idx(name);
            return j === -1 ? '' : (fields[j] ?? '');
        };
        const slug = at('slug').toLowerCase();
        if (!slug) {
            errors.push(`line ${i + 1}: missing slug`);
            continue;
        }
        const kind = at('kind') === 'company' ? 'company' : 'person';
        const cadence = at('cadence_class');
        const provided = at('linkedin_url');
        const url = normalizeLinkedInUrl(provided) ??
            normalizeLinkedInUrl(`https://www.linkedin.com/${kind === 'company' ? 'company' : 'in'}/${slug}`);
        if (provided && normalizeLinkedInUrl(provided) === null) {
            errors.push(`line ${i + 1}: "${provided}" is not a URL shape this loader recognises — falling back to ${url ?? 'nothing'}; verify it before the first live poll`);
        }
        if (!url) {
            errors.push(`line ${i + 1}: cannot derive a LinkedIn URL for "${slug}"`);
            continue;
        }
        const tierRaw = Number(at('tier') || '1');
        rows.push({
            slug,
            kind,
            displayName: at('display_name') || null,
            linkedinUrl: url,
            tier: Number.isFinite(tierRaw) ? tierRaw : 1,
            track: at('track').toLowerCase() !== 'false',
            cadenceClass: (CADENCE.has(cadence) ? cadence : 'unknown') as SeedRow['cadenceClass'],
            notes: at('notes') || null,
            companyName: at('company_name') || null,
        });
    }
    return { rows, errors };
}
async function main(): Promise<void> {
    const path = process.argv[2];
    const apply = process.argv.includes('--apply');
    if (!path) {
        console.error('usage: npm run seeds:load -- <file.csv> [--apply]');
        process.exit(1);
    }
    const { rows, errors } = parseSeedCsv(await readFile(path, 'utf8'));
    for (const e of errors)
        console.error(`  ! ${e}`);
    console.log(`parsed ${rows.length} seed accounts from ${path}`);
    if (!apply) {
        console.log('\nDRY RUN — nothing written. Re-run with --apply.\n');
        for (const r of rows) {
            console.log(`  ${r.track ? '+' : '-'} ${r.slug.padEnd(24)} ${r.kind.padEnd(8)} tier ${r.tier}  ${r.cadenceClass.padEnd(12)} ${r.companyName ?? ''}`);
        }
        return;
    }
    let created = 0;
    for (const row of rows) {
        const result = await repo.upsertSeedAccount(row);
        if (result.created)
            created += 1;
    }
    console.log(`applied: ${created} created, ${rows.length - created} updated`);
}
const isMain = process.argv[1]?.endsWith('load_seed_accounts.ts');
if (isMain) {
    main()
        .then(() => closeDb())
        .catch(async (err) => {
        console.error(err);
        await closeDb();
        process.exit(1);
    });
}
