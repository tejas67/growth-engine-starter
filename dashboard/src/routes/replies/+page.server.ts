/**
 * Replies — every answer we have, grouped by the person who sent it.
 *
 * Two rules this page exists to honour:
 *  - The founder replies IN GMAIL. There is no compose box here and nothing on this
 *    page ever sends anything. The only outbound affordance is a link to the thread.
 *  - Whether a reply is POSITIVE is the founder's call, never a model's. The buttons
 *    write the verdict; nothing infers it.
 *
 * Matched conversations and unmatched mail have separate, paginated inboxes.
 * Unrelated newsletters must never crowd campaign conversations out of the queue.
 */
import { fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { config } from '$config';
import { withTx } from '$db';
import { humanAge } from '$core/lib/time.js';
import { addSuppression, insertAudit, insertEvent, pauseSequence } from '$core/repo/index.js';
import {
  aliasesForProspect,
  clearFounderVerdicts,
  listPausedProspects,
  listReplies,
  replyById,
  type ReplyRow,
} from '$lib/server/queries';
import { replyInbox } from '$lib/server/inbox';
import { gmailLink, replyExcerpt, replyFrom, replySubject } from '$lib/display';
import type { ReplyCard, ReplyThread } from '$lib/types';

const VERDICTS = new Set(['positive_reply', 'negative_reply', 'neutral_reply']);

function toCard(row: ReplyRow, now: Date): ReplyCard {
  const occurredAt = new Date(row.occurred_at);
  return {
    eventId: row.id,
    kind: row.kind,
    channel: row.channel ?? row.touch_channel,
    occurredAt: occurredAt.toISOString(),
    age: humanAge(occurredAt, now),
    excerpt: replyExcerpt(row.payload),
    subject: replySubject(row.payload),
    from: replyFrom(row.payload),
    gmailUrl:
      (row.channel ?? row.touch_channel) === 'email'
        ? gmailLink(config.ingest.gmailDeepLinkBase, {
            payload: row.payload,
            gmailThreadUrl: row.gmail_thread_url,
            emailMessageId: row.email_message_id,
          })
        : null,
    touchId: row.touch_id,
    founderVerdict: row.founder_verdict,
  };
}

export const load: ServerLoad = async ({ url }) => {
  const inbox = await replyInbox(url.searchParams);
  const now = new Date();
  const items = inbox.rows.map((row) => ({
    id: inbox.view === 'conversations' ? String(row.prospect_id) : row.event_id,
    name:
      inbox.view === 'conversations'
        ? (row.full_name ?? 'Name not captured')
        : (replyFrom(row.payload) ?? 'Unknown sender'),
    companyName: row.company_name,
    headline: row.headline,
    email: row.email,
    linkedinUrl: row.linkedin_url,
    subject: replySubject(row.payload),
    excerpt: replyExcerpt(row.payload),
    paused: row.sequence_paused_at !== null,
    age: humanAge(new Date(row.occurred_at), now),
    at: new Date(row.occurred_at).toISOString(),
  }));
  const selected =
    items.find((item) => item.id === url.searchParams.get('item')) ?? items[0] ?? null;
  const replies = selected
    ? (
        await listReplies(
          100,
          undefined,
          inbox.view === 'conversations'
            ? { prospectId: Number(selected.id) }
            : { eventId: selected.id },
        )
      ).map((row) => toCard(row, now))
    : [];
  const paused = (await listPausedProspects(100)).map((p) => ({
    id: p.id,
    name: p.full_name ?? 'Name not captured',
    companyName: p.company_name,
    pausedAge: humanAge(new Date(p.sequence_paused_at), now),
    reason: p.sequence_pause_reason,
  }));
  return {
    items,
    selected,
    replies,
    paused,
    view: inbox.view,
    query: inbox.query,
    counts: inbox.counts,
    total: inbox.total,
    page: inbox.page,
    pages: inbox.pages,
    offset: inbox.offset,
    detailOpen: url.searchParams.has('item'),
  };
};

export const actions: Actions = {
  /**
   * Record the founder's verdict on one reply. Idempotent: the event key is derived
   * from the reply's own id, so tapping the same button twice writes one row.
   * Changing your mind replaces the previous verdict rather than stacking a second.
   */
  classify: async ({ request, locals }) => {
    const form = await request.formData();
    const eventId = String(form.get('eventId') ?? '').trim();
    const kind = String(form.get('kind') ?? '');

    if (!/^\d+$/.test(eventId)) return fail(400, { message: 'that reply could not be identified' });
    if (!VERDICTS.has(kind)) return fail(400, { message: 'that is not a verdict we record' });

    const source = await replyById(eventId);
    if (!source) return fail(404, { message: 'that reply is no longer here' });

    const now = new Date();
    await withTx(async (client) => {
      await clearFounderVerdicts(eventId, kind, client);
      const recorded = await insertEvent(
        {
          eventKey: `dashboard:reclassify:${eventId}:${kind}`,
          touchId: source.touch_id,
          prospectId: source.prospect_id,
          kind,
          channel: source.channel ?? source.touch_channel,
          source: 'dashboard',
          payload: { source_event_id: eventId, classified_by: locals.user, from_kind: source.kind },
          occurredAt: now,
        },
        client,
      );
      // Same double-tap discipline as approving: pressing the same verdict twice
      // records nothing the second time. `recorded` is false when the row was
      // already there. approval_audit also hangs off a touch, so an unmatched reply
      // has nowhere to put one — the event itself carries who classified it.
      if (recorded && source.touch_id !== null) {
        await insertAudit(
          {
            touchId: source.touch_id,
            actor: locals.user!,
            action: 'reclassify',
            beforeHash: null,
            afterHash: null,
            detail: { sourceEventId: eventId, from: source.kind, to: kind },
          },
          client,
        );
      }
    });

    return { ok: true, message: `Recorded. You marked that reply ${kind.replace('_reply', '')}.` };
  },

  /**
   * "Not interested" — a permanent suppression against every identifier we hold for
   * this person, and the rest of their sequence stays stopped.
   */
  notInterested: async ({ request, locals }) => {
    const form = await request.formData();
    const prospectId = Number(form.get('prospectId'));
    if (!Number.isInteger(prospectId) || prospectId <= 0) {
      return fail(400, { message: 'that person could not be identified' });
    }

    const aliases = await aliasesForProspect(prospectId);
    await withTx(async (client) => {
      for (const alias of aliases) {
        await addSuppression(
          { prospectId, alias, reason: 'founder marked not interested', source: 'dashboard' },
          client,
        );
      }
      await pauseSequence(prospectId, 'founder marked not interested', client);
    });

    return {
      ok: true,
      message:
        aliases.length > 0
          ? `Done. We will not contact them again on any of the ${aliases.length} address(es) we hold, and the rest of the sequence stays stopped.`
          : 'Their sequence is stopped. We hold no addresses for them to suppress, so there was nothing else to block.',
    };
  },
};
