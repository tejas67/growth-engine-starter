import { z } from 'zod';
import { db, closeDb } from '../../db/client.js';
import { config } from '../../config/index.js';
import { asQuotedData, callStructured } from '../clients/claude.js';
import { lintDraft } from '../copy/lint.js';
import { defaultDraftRunner, loadCopywriter } from '../pipeline/draft.js';
const NoteSchema = z.object({ connect_note: z.string().min(10).max(300) });
const dry = process.argv.includes('--dry');
const pool = db();
const runner = defaultDraftRunner();
const copywriter = await loadCopywriter();
const { rows } = await pool.query<{
    id: number;
    body: string;
    channel: string;
    full_name: string | null;
    headline: string | null;
    location: string | null;
    company_name: string | null;
    company_verified: boolean;
}>(`SELECT t.id, t.body, t.channel, p.full_name, p.headline, p.location, p.company_name, p.company_verified
      FROM touch t JOIN prospect p ON p.id = t.prospect_id
     WHERE t.status = 'draft' AND t.connect_note IS NULL AND t.channel <> 'email'
     ORDER BY t.hot DESC, t.id`);
let written = 0;
let failed = 0;
for (const r of rows) {
    const forbiddenNames = !r.company_verified && r.company_name ? [r.company_name] : [];
    const base = [
        'Write ONLY the connection note (connect_note) for this person. The message below is already written and will be sent after they accept; the note must stand alone, read as a plain reason to connect, and must not repeat or shorten the message.',
        `Their first name: ${r.full_name?.split(' ')[0] ?? '(unknown, use no name)'}`,
        r.company_verified && r.company_name ? `Their company: ${r.company_name}` : 'Their company: UNKNOWN, do not name or guess one.',
        asQuotedData('their_headline', r.headline),
        asQuotedData('their_location', r.location),
        asQuotedData('the_message_that_follows', r.body),
        'Return exactly {"connect_note": "..."} and nothing else.',
    ].join('\n');
    let prompt = base;
    let note: string | null = null;
    let issues: string[] = [];
    for (let attempt = 0; attempt < 3 && note === null; attempt++) {
        try {
            const { value } = await callStructured(runner, NoteSchema, prompt, copywriter, 1);
            const lint = lintDraft(value.connect_note, { scrapedText: [r.headline ?? '', r.body], channel: 'connect', forbiddenNames });
            const errors = lint.violations.filter((v) => v.severity === 'error');
            if (errors.length === 0) {
                note = value.connect_note;
                break;
            }
            issues = errors.map((v) => `${v.rule}: ${v.detail}`);
            prompt = `${base}\n\nYour previous note was REJECTED:\n${issues.map((i) => `- ${i}`).join('\n')}\n<rejected_note>\n${value.connect_note}\n</rejected_note>\nRewrite it.`;
        }
        catch (err) {
            issues = [(err as Error).message];
            break;
        }
    }
    if (note === null) {
        failed++;
        console.log(JSON.stringify({ touch: r.id, failed: issues }));
        continue;
    }
    written++;
    if (!dry)
        await pool.query(`UPDATE touch SET connect_note = $2 WHERE id = $1 AND status = 'draft'`, [r.id, note]);
    console.log(JSON.stringify({ touch: r.id, note }));
}
console.log(JSON.stringify({ candidates: rows.length, written: dry ? 0 : written, wouldWrite: dry ? written : undefined, failed }));
await closeDb();
