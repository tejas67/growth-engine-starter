import { db, closeDb } from '../../db/client.js';
import { lintDraft } from '../copy/lint.js';
const dry = process.argv.includes('--dry');
const pool = db();
const { rows } = await pool.query(`
  SELECT t.id, t.prospect_id, t.body, t.connect_note, t.channel, p.company_name, p.company_verified, p.headline
    FROM touch t JOIN prospect p ON p.id = t.prospect_id
   WHERE t.status = 'draft'`);
let failed = 0;
let notesCleared = 0;
const rules = new Map<string, number>();
for (const r of rows) {
    const forbiddenNames = !r.company_verified && r.company_name ? [r.company_name] : [];
    const lint = lintDraft(r.body, { channel: r.channel, forbiddenNames });
    const errors = lint.violations.filter((v) => v.severity === 'error');
    const noteErrors = r.connect_note
        ? lintDraft(r.connect_note, { channel: 'connect', forbiddenNames }).violations.filter((v) => v.severity === 'error')
        : [];
    if (errors.length === 0 && noteErrors.length > 0) {
        for (const v of noteErrors)
            rules.set(`note:${v.rule}`, (rules.get(`note:${v.rule}`) ?? 0) + 1);
        notesCleared++;
        if (!dry)
            await pool.query(`UPDATE touch SET connect_note = NULL WHERE id = $1 AND status = 'draft'`, [r.id]);
        continue;
    }
    if (errors.length === 0)
        continue;
    failed++;
    for (const v of errors)
        rules.set(v.rule, (rules.get(v.rule) ?? 0) + 1);
    if (dry)
        continue;
    await pool.query(`UPDATE touch SET status = 'skipped' WHERE id = $1 AND status = 'draft'`, [r.id]);
    await pool.query(`UPDATE prospect SET state = 'enriched', updated_at = NOW() WHERE id = $1 AND state = 'drafted'`, [r.prospect_id]);
}
console.log(JSON.stringify({ drafts: rows.length, failing: failed, requeued: dry ? 0 : failed, notesCleared: dry ? 0 : notesCleared, byRule: Object.fromEntries(rules) }));
await closeDb();
