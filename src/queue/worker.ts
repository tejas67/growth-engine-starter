import { drain } from '../pipeline/drain.js';
import { config } from '../../config/index.js';
import { closeDb } from '../../db/client.js';
import { logger } from '../lib/log.js';
import { runResolve } from '../pipeline/resolve.js';
import { runScrapeForSource } from '../pipeline/scrape_source.js';
import { runBridge, runDraft, runEnrich, runIngest, runPrune, runScore, runSend, runVerify, } from '../pipeline/stages.js';
import { collectDigest, emailDigest, renderDigest, writeDigest } from '../report/digest.js';
import { runWeeklyAnalyst } from '../report/weekly.js';
import { ensureQueues, getBoss, QUEUES, registerSchedules, stopBoss } from './boss.js';
import { withStageLock } from '../lib/stage_lock.js';
const log = logger('worker');
async function main(): Promise<void> {
    const boss = await getBoss();
    await ensureQueues(boss);
    const handlers: Array<[
        string,
        () => Promise<unknown>
    ]> = [
        [QUEUES.refresh, async () => {
                await withStageLock(QUEUES.scrape, () => runScrapeForSource());
                await withStageLock(QUEUES.score, () => drain(runScore, config.score.runBudgetMs));
                await withStageLock(QUEUES.verify, () => runVerify());
                await withStageLock(QUEUES.enrich, () => runEnrich());
                return withStageLock(QUEUES.draft, () => runDraft());
            }],
        [QUEUES.scrape, () => runScrapeForSource()],
        [QUEUES.score, () => drain(runScore, config.score.runBudgetMs)],
        [QUEUES.verify, () => runVerify()],
        [QUEUES.enrich, () => runEnrich()],
        [QUEUES.draft, () => runDraft()],
        [QUEUES.bridge, () => runBridge()],
        [QUEUES.send, () => runSend()],
        [QUEUES.ingest, () => runIngest()],
        [QUEUES.prune, () => runPrune()],
        [QUEUES.resolve, () => runResolve()],
        [
            QUEUES.analyst,
            async () => {
                const result = await runWeeklyAnalyst();
                return { path: result.path, week: result.week, narrated: result.narrated };
            },
        ],
        [
            QUEUES.digest,
            async () => {
                const model = await collectDigest();
                const markdown = renderDigest(model);
                const path = await writeDigest(markdown, model.day);
                await emailDigest(markdown);
                return { path, alarms: model.alarms.length };
            },
        ],
    ];
    for (const [queue, handler] of handlers) {
        await boss.work(queue, async () => {
            const started = Date.now();
            try {
                const result = await withStageLock(queue, handler);
                log.info('job complete', { queue, ms: Date.now() - started, result });
            }
            catch (err) {
                log.error('job failed', { queue, ms: Date.now() - started, error: (err as Error).message });
                throw err;
            }
        });
    }
    await registerSchedules(boss);
    log.info('worker up', {
        dryRun: config.dryRun,
        scrapeSource: config.scrape.source,
        scrapeMode: config.scrape.mode,
        unipileMode: config.unipile.mode,
        llmMode: config.score.mode,
        dmEnabled: config.send.dmEnabled,
        emailEnabled: config.send.emailEnabled,
    });
    const shutdown = async (signal: string): Promise<void> => {
        log.info('shutting down', { signal });
        await stopBoss();
        await closeDb();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
main().catch(async (err) => {
    log.error('worker failed to start', { error: (err as Error).message });
    await stopBoss();
    await closeDb();
    process.exit(1);
});
