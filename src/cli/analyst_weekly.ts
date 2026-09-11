import { closeDb } from '../../db/client.js';
import { config } from '../../config/index.js';
import { runWeeklyAnalyst } from '../report/weekly.js';
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const stdout = args.includes('--stdout');
    const noModel = args.includes('--no-model');
    const weekArg = args[args.indexOf('--week') + 1];
    const now = args.includes('--week') && weekArg ? new Date(weekArg) : new Date();
    if (Number.isNaN(now.getTime())) {
        console.error(`--week needs a date inside the week you want, e.g. --week 2026-08-24`);
        process.exit(1);
    }
    const result = await runWeeklyAnalyst({ now, ...(noModel ? { runner: null } : {}) });
    if (stdout) {
        console.log(result.markdown);
        return;
    }
    console.log(`weekly readout written to ${result.path}`);
    console.log(result.narrated
        ? 'commentary: written by Claude over the computed numbers'
        : `commentary: none (GROWTH_LLM_MODE=${config.analyst.mode}${noModel ? ', --no-model' : ''}) — the tables are still complete`);
}
main()
    .then(() => closeDb())
    .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
});
