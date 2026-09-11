import { closeDb } from '../../db/client.js';
import { parseHoldReleaseArgs, planHoldRelease } from '../pipeline/holds.js';
import * as repo from '../repo/index.js';
async function main(): Promise<void> {
    const args = parseHoldReleaseArgs(process.argv.slice(2));
    if (!args.allOfKind && (args.reasons ?? []).length === 0) {
        console.error('refusing to run with no filter: pass --reason <a,b> or --all-of-kind (optionally with --stage)');
        process.exit(1);
    }
    const holds = await repo.listOpenHolds({ stage: args.stage });
    const plan = planHoldRelease(holds, args);
    console.log(`[holds:release] ${holds.length} open hold(s)` +
        `${args.stage ? ` at stage ${args.stage}` : ' across all stages'}` +
        ` — matched ${plan.holdIds.length}, of which ${plan.prospectIds.length} prospect(s) to re-queue` +
        ` and ${plan.resolvedOnly.length} resolved without a re-queue (seed/post/lane subjects).`);
    if (args.dryRun) {
        console.log('[holds:release] --dry-run: nothing was written.');
        return;
    }
    const result = await repo.applyHoldRelease(plan, 'cli');
    console.log(`[holds:release] resolved ${result.holdsResolved} hold(s), re-queued ${result.prospectsRequeued} prospect(s) to state='new'.`);
}
main()
    .then(() => closeDb())
    .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
});
