import { config } from '$config';
import { HeyReachClient, type AccountStatus } from '$core/clients/heyreach.js';

// Coalesce concurrent page loads; do not make a vendor request for each draft click.
let cacheKey = '';
let cached: { expires: number; value: Promise<AccountStatus> } | undefined;
export function sendingIdentity(): Promise<AccountStatus> {
  const key = [config.send.heyreachKey, config.send.heyreachLinkedInAccountId].join(':');
  if (key !== cacheKey || !cached || cached.expires < Date.now()) {
    cacheKey = key;
    cached = {
      expires: Date.now() + 30_000,
      value: new HeyReachClient().senderIdentity().catch(() => ({
        connected: false, restricted: false, detail: 'Unable to verify the LinkedIn sender',
      })),
    };
  }
  return cached.value;
}
