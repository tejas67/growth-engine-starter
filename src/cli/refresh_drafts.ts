import { closeDb } from '../../db/client.js';
import { config } from '../../config/index.js';
import { withStageLock } from '../lib/stage_lock.js';
import { refreshDrafts } from '../pipeline/refresh_drafts.js';
try {
    const apply = process.argv.includes('--apply');
    const result = await withStageLock('draft', () => refreshDrafts(config.draft.copywriterVersion, apply));
    console.log(JSON.stringify({ version: config.draft.copywriterVersion, apply, ...result }));
}
finally {
    await closeDb();
}
