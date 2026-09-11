import PgBoss from 'pg-boss';
import { config } from '../../config/index.js';
import { logger } from '../lib/log.js';
const log = logger('queue');
export const QUEUES = {
    scrape: 'scrape',
    score: 'score',
    verify: 'verify',
    enrich: 'enrich',
    draft: 'draft',
    bridge: 'bridge',
    send: 'send',
    ingest: 'ingest',
    digest: 'digest',
    analyst: 'analyst',
    prune: 'prune',
    resolve: 'resolve',
    refresh: 'refresh',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const SCHEDULES: Array<{
    queue: QueueName;
    cron: string;
    why: string;
}> = [
    { queue: QUEUES.scrape, cron: '*/30 * * * *', why: 'new-post detection + engager pulls' },
    { queue: QUEUES.score, cron: '10,40 * * * *', why: 'ICP scoring drain, 10 min after each scrape tick' },
    { queue: QUEUES.verify, cron: '15,45 * * * *', why: 'company web verification (follows scoring)' },
    { queue: QUEUES.enrich, cron: '20,50 * * * *', why: 'Apollo enrichment + re-score (follows verify)' },
    { queue: QUEUES.draft, cron: '25,55 * * * *', why: 'draft touches for the approval queue (follows enrich)' },
    { queue: QUEUES.send, cron: '*/20 * * * *', why: 'dispatch approved touches inside the send window' },
    { queue: QUEUES.digest, cron: '0 12 * * *', why: 'daily digest' },
    { queue: QUEUES.analyst, cron: '0 12 * * 1', why: 'weekly analyst readout' },
    { queue: QUEUES.prune, cron: '30 4 * * *', why: '90-day raw comment-text pruning' },
    { queue: QUEUES.resolve, cron: '5 * * * *', why: 'upgrade internal-id prospects to a real slug (Unipile profile read)' },
];
let boss: PgBoss | null = null;
export async function getBoss(): Promise<PgBoss> {
    if (boss)
        return boss;
    boss = new PgBoss({
        connectionString: config.database.url,
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        archiveCompletedAfterSeconds: 60 * 60 * 24 * 7,
    });
    boss.on('error', (err) => log.error('pg-boss error', { error: err.message }));
    await boss.start();
    return boss;
}
export async function stopBoss(): Promise<void> {
    if (boss) {
        await boss.stop({ graceful: true });
        boss = null;
    }
}
export async function ensureQueues(instance: PgBoss): Promise<void> {
    for (const queue of Object.values(QUEUES)) {
        await instance.createQueue(queue);
    }
}
export async function registerSchedules(instance: PgBoss): Promise<void> {
    for (const schedule of SCHEDULES) {
        await instance.schedule(schedule.queue, schedule.cron, undefined, { tz: 'UTC' });
        log.info('scheduled', { queue: schedule.queue, cron: schedule.cron, why: schedule.why });
    }
}
