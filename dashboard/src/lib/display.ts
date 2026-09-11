/**
 * Small pure helpers shared by the three views. Nothing here talks to a database, so
 * both the server load functions and the components can use them.
 */

/** A percentage, or a dash when the number is deliberately withheld. */
export function pct(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export function whenLocal(at: Date | string | null): string {
  if (!at) return 'unknown';
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

const REPLY_LABEL: Record<string, string> = {
  reply: 'Reply',
  positive_reply: 'Positive',
  negative_reply: 'Negative',
  neutral_reply: 'Neutral',
  unmatched_reply: 'Unmatched reply',
};

export function replyLabel(kind: string): string {
  return REPLY_LABEL[kind] ?? kind;
}

function firstString(payload: Record<string, unknown> | null, keys: string[]): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * What the person actually wrote, as far as the ingest stage captured it. Never
 * invented: when the payload carries no text, say so rather than showing a summary
 * nobody wrote.
 */
export function replyExcerpt(payload: Record<string, unknown> | null): string | null {
  return firstString(payload, ['excerpt', 'snippet', 'text', 'body', 'message', 'preview']);
}

export function replySubject(payload: Record<string, unknown> | null): string | null {
  return firstString(payload, ['subject', 'title']);
}

export function replyFrom(payload: Record<string, unknown> | null): string | null {
  return firstString(payload, ['from', 'from_address', 'sender', 'email']);
}

export interface GmailLinkSource {
  payload: Record<string, unknown> | null;
  gmailThreadUrl?: string | null;
  emailMessageId?: string | null;
}

/**
 * Deep link into the Gmail thread. The founder answers in Gmail — the dashboard only
 * has to get them there, so this is a link and never a compose box.
 *
 * A thread id addresses the conversation directly; an RFC-822 Message-ID has to be
 * searched for, which Gmail supports with the `rfc822msgid:` operator.
 */
export function gmailLink(base: string, source: GmailLinkSource): string | null {
  const threadId = firstString(source.payload, ['gmailThreadId', 'gmail_thread_id', 'threadId']);
  if (threadId) return `${base}/${encodeURIComponent(threadId)}`;

  if (source.gmailThreadUrl) return source.gmailThreadUrl;

  const messageId =
    firstString(source.payload, ['messageId', 'message_id', 'rfc822MessageId']) ??
    source.emailMessageId ??
    null;
  if (messageId) {
    const bare = messageId.replace(/^<|>$/g, '');
    return `${base}/rfc822msgid:${encodeURIComponent(bare)}`;
  }
  return null;
}
