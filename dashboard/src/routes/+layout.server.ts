import { readSettings, profileReady } from '$local';
import type { LayoutServerLoad } from './$types';
import { config } from '$config';
import { getLaneState } from '$core/repo/index.js';
import { workspaceCounts } from '$lib/server/inbox';
import { sendingIdentity } from '$lib/server/sender';

export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.user) return { user: null, counts: null, sending: false, sender: null };
  const [counts, killSwitch, sender] = await Promise.all([
    workspaceCounts(),
    getLaneState<{ sending_enabled?: boolean }>('kill_switch', { sending_enabled: false }),
    sendingIdentity(),
  ]);
  return {
    user: locals.user,
    businessName: readSettings().business.name,
    profileReady: profileReady(),
    counts,
    sender,
    sending:
      !config.dryRun &&
      killSwitch.sending_enabled === true &&
      (config.send.dmEnabled || config.send.emailEnabled),
  };
};
