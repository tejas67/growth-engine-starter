import { closeDb, db } from '../../db/client.js';
import { collectDigest, emailDigest, renderDigest, writeDigest } from '../report/digest.js';
async function main(): Promise<void> {
    const model = await collectDigest();
    const markdown = renderDigest(model);
    if (process.argv.includes('--stdout')) {
        console.log(markdown);
        return;
    }
    const path = await writeDigest(markdown, model.day);
    await db().query(`INSERT INTO digest_run (day, markdown) VALUES ($1,$2)
     ON CONFLICT (day) DO UPDATE SET markdown = EXCLUDED.markdown`, [model.day, markdown]);
    const mail = await emailDigest(markdown);
    console.log(`digest written to ${path}`);
    console.log(`email: ${mail.reason}`);
    if (model.alarms.length > 0) {
        console.log(`\n${model.alarms.length} alarm(s):`);
        for (const a of model.alarms)
            console.log(`  - ${a.replace(/\*\*/g, '')}`);
    }
}
main()
    .then(() => closeDb())
    .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
});
