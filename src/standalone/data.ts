import { z } from 'zod';
import { db, withTx } from '../../db/client.js';
import { upsertProspect } from '../repo/index.js';
export function profileUrl(raw: string): string {
    const url = new URL(raw.startsWith('https://') ? raw : `https://${raw}`);
    if (!['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port || url.protocol !== 'https:' || !/^\/in\/[a-zA-Z0-9_%.-]+\/?$/.test(url.pathname))
        throw new Error('Use a LinkedIn person URL, such as https://www.linkedin.com/in/their-profile.');
    const slug = decodeURIComponent(url.pathname.split('/')[2]!).toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(slug) || /^(demo-|sample-|example-|your-|their-)/.test(slug))
        throw new Error('Replace the sample URL with the real prospect’s LinkedIn URL.');
    return `https://www.linkedin.com/in/${slug}`;
}
const ProspectInput = z.object({ linkedin_url: z.string().trim().min(1), full_name: z.string().trim().min(2).max(120), headline: z.string().trim().min(5).max(500), company: z.string().trim().max(150).default(''), context: z.string().trim().min(20).max(3000) });
export type ProspectInput = z.infer<typeof ProspectInput>;
export function parseProspect(input: unknown): ProspectInput {
    const parsed = ProspectInput.parse(input);
    return { ...parsed, linkedin_url: profileUrl(parsed.linkedin_url) };
}
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c === '"') {
            if (quoted && text[i + 1] === '"') {
                field += '"';
                i++;
            }
            else
                quoted = !quoted;
        }
        else if (c === ',' && !quoted) {
            row.push(field);
            field = '';
        }
        else if ((c === '\n' || c === '\r') && !quoted) {
            if (c === '\r' && text[i + 1] === '\n')
                i++;
            row.push(field);
            if (row.some(x => x.trim()))
                rows.push(row);
            row = [];
            field = '';
        }
        else
            field += c;
    }
    if (quoted)
        throw new Error('CSV has an unclosed quoted field.');
    row.push(field);
    if (row.some(x => x.trim()))
        rows.push(row);
    return rows;
}
export function parseProspectCsv(csv: string): ProspectInput[] {
    if (Buffer.byteLength(csv) > 1000000)
        throw new Error('CSV limit is 1 MB.');
    const [header, ...rows] = parseCsv(csv.replace(/^\uFEFF/, ''));
    const keys = header?.map(v => v.trim().toLowerCase()) ?? [];
    if (['linkedin_url', 'full_name', 'headline', 'context'].some(k => !keys.includes(k)))
        throw new Error('CSV needs linkedin_url, full_name, headline, company, and context columns.');
    if (!rows.length || rows.length > 500)
        throw new Error('Import between 1 and 500 prospects at a time.');
    return rows.map((row, i) => { try {
        return parseProspect(Object.fromEntries(keys.map((k, n) => [k, row[n] ?? ''])));
    }
    catch {
        throw new Error(`Row ${i + 2}: use a real LinkedIn URL, name, headline, and at least 20 characters of relevant context.`);
    } });
}
export async function importProspects(inputs: ProspectInput[]): Promise<number> {
    const parsed = inputs.map(parseProspect);
    return withTx(async (client) => {
        for (const row of parsed) {
            const result = await upsertProspect({ linkedinUrl: row.linkedin_url, linkedinSlug: row.linkedin_url.split('/').at(-1)!, fullName: row.full_name, headline: row.headline, location: null, countryClass: 'unknown', isCompanyPage: false, companyName: row.company || null, profileJson: { source: 'manual', context: row.context } }, client);
            await client.query('UPDATE prospect SET source_note=$2 WHERE id=$1', [result.id, row.context]);
        }
        return parsed.length;
    });
}
export async function loadDemo(): Promise<number> {
    const examples = [
        { slug: 'alex-example', name: 'Alex Example', headline: 'Operations lead at Fictional Field Services', context: 'Synthetic example: a field service team coordinates technician visits with spreadsheets.', body: 'Alex, scheduling technicians across a busy week can leave dispatchers juggling last-minute changes. We help field service teams put availability and jobs in one place. I can walk through a sample weekly schedule with you. Would that be useful?', note: 'Alex, we help field service teams simplify technician scheduling. I can show you a sample week with availability and jobs in one place. Open to connecting?' },
        { slug: 'jordan-example', name: 'Jordan Example', headline: 'Owner at Fictional Repairs', context: 'Synthetic example: a repair business wants customers to know when a technician will arrive.', body: 'Jordan, customers waiting for a repair visit need a clear arrival window. We help repair teams send updates when the schedule changes. I can show you how that looks from the customer’s side. Want to see an example?', note: 'Jordan, we help repair teams keep customers updated when visit times change. I can show you a simple customer-side example. Open to connecting?' },
        { slug: 'sam-example', name: 'Sam Example', headline: 'Service manager at Fictional Maintenance', context: 'Synthetic example: a maintenance team is reviewing how it assigns recurring jobs.', body: 'Sam, recurring maintenance gets harder to schedule when each site needs a different technician. We help service teams plan around skills and availability. I can show you a sample plan for a mixed set of jobs. Would that help?', note: 'Sam, we help service teams plan recurring jobs around technician skills and availability. I can show you a sample plan. Open to connecting?' },
    ];
    return withTx(async (client) => {
        let added = 0;
        for (const item of examples) {
            const { rows } = await client.query("INSERT INTO prospect(linkedin_url,linkedin_slug,full_name,headline,state,is_demo,source_note) VALUES($1,$2,$3,$4,'drafted',TRUE,$5) ON CONFLICT(linkedin_url) DO NOTHING RETURNING id", [`https://demo.invalid/people/${item.slug}`, item.slug, item.name, item.headline, item.context]);
            if (!rows[0])
                continue;
            const id = rows[0].id;
            await client.query("INSERT INTO touch(prospect_id,channel,template_version,angle,persona,signal_type,body,connect_note,dry_run,generation_provider,generation_model) VALUES($1,'dm','demo-v1','A3','P1','none',$2,$3,TRUE,'demo','Synthetic example')", [id, item.body, item.note]);
            added++;
        }
        return added;
    });
}
