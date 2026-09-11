import { closeDb } from '../../db/client.js';
import { config } from '../../config/index.js';
import { withStageLock } from '../lib/stage_lock.js';
import { runResolve } from '../pipeline/resolve.js';
import { runScrapeForSource } from '../pipeline/scrape_source.js';
import { runBridge, runDraft, runEnrich, runIngest, runPrune, runScore, runSend, runVerify, } from '../pipeline/stages.js';
const STAGES: Record<string, () => Promise<unknown>> = {
    scrape: () => runScrapeForSource(),
    score: () => runScore(),
    verify: () => runVerify(),
    enrich: () => runEnrich(),
    draft: () => runDraft(),
    bridge: () => runBridge(),
    send: () => runSend(),
    ingest: () => runIngest(),
    prune: () => runPrune(),
    resolve: () => runResolve(),
};
async function main(): Promise<void> {
    const stage = process.argv[2];
    if (!stage || !STAGES[stage]) {
        console.error(`usage: run_stage.ts <${Object.keys(STAGES).join('|')}>`);
        process.exit(1);
    }
    console.log(`[run_stage] ${stage} — dryRun=${config.dryRun} scrapeSource=${config.scrape.source} ` +
        `scrapeMode=${config.scrape.mode} unipileMode=${config.unipile.mode} llmMode=${config.score.mode}`);
    const result = await withStageLock(stage, STAGES[stage]!);
    console.log(JSON.stringify(result, null, 2));
}
main()
    .then(() => closeDb())
    .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
});
