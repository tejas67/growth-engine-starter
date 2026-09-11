/** URL state is shared by server reads and links, including after a review action. */
export const PAGE_SIZE = 25;
export type QueueFilter = 'all' | 'priority';
export type QueueChannel = 'all' | 'dm' | 'email';
export type QueueSort = 'newest' | 'oldest';

export function positiveId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
export function queueParams(params: URLSearchParams) {
  return {
    q: (params.get('q') ?? '').trim().slice(0, 120),
    filter: (params.get('filter') === 'priority' ? 'priority' : 'all') as QueueFilter,
    channel: (['dm', 'email'].includes(params.get('channel') ?? '')
      ? params.get('channel')
      : 'all') as QueueChannel,
    sort: (params.get('sort') === 'oldest' ? 'oldest' : 'newest') as QueueSort,
    page: positiveId(params.get('page')) ?? 1,
    draft: positiveId(params.get('draft')),
  };
}
/** Search is literal: a company called 100% must not match the whole queue. */
export function searchPattern(text: string): string {
  return '%' + text.replace(/[\\%_]/g, '\\$&') + '%';
}
export function pageWindow(requested: number, total: number) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, requested), pages);
  return { page, pages, offset: (page - 1) * PAGE_SIZE };
}
export function inboxUrl(
  path: string,
  current: URLSearchParams,
  changes: Record<string, string | number | null>,
): string {
  const params = new URLSearchParams(current);
  // Named SvelteKit form actions must never leak into navigation links.
  for (const key of [...params.keys()]) if (key.startsWith('/')) params.delete(key);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  return path + (params.size ? '?' + params : '');
}
/** Keep the edited draft selected; advance only after a successful decision. */
export function nextDraftId(ids: number[], current: number): number | null {
  const index = ids.indexOf(current);
  return ids[index + 1] ?? ids[index - 1] ?? null;
}
export function initials(name: string | null | undefined): string {
  return (
    (name ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => Array.from(part)[0])
      .join('')
      .toUpperCase() || '?'
  );
}
const PERSONAS: Record<string, string> = {
  P0: 'Outside target audience',
  P1: 'Defense tech founder / operator',
  P2: 'Small business owner / BD',
  P3: 'Business development / capture',
  P4: 'Government / advisory',
};
export function personaLabel(persona: string | null): string {
  return persona ? (PERSONAS[persona] ?? persona) : 'Not assessed';
}
export function channelLabel(channel: string | null): string {
  return channel === 'email'
    ? 'Email'
    : channel === 'dm' || channel === 'connect'
      ? 'LinkedIn'
      : 'Unknown channel';
}
export function signalVerb(kind: string): string {
  return kind === 'comment' ? 'Commented on' : kind === 'repost' ? 'Reposted' : 'Liked';
}
