/**
 * Approve — today's batch of drafts.
 *
 * Drafts never expire. Their AGE is shown on every card so staleness is visible, and
 * the founder decides what to do about it; nothing here throws work away on a timer.
 */
import { fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { matchRunsForTouches } from '$core/repo/index.js';
import { queueParams } from '$lib/inbox';
import { reviewQueue } from '$lib/server/inbox';
import { humanAge } from '$core/lib/time.js';
import { prospectsByIds, signalsByProspectIds } from '$lib/server/queries';
import { approveMany, approveTouch, editTouch, skipTouch } from '$lib/server/transitions';
import type { DraftCard } from '$lib/types';

export const load: ServerLoad = async ({ url }) => {
  const filters = queueParams(url.searchParams);
  const result = await reviewQueue(filters);
  const queue = result.rows;
  const prospectIds = [...new Set(queue.map((t) => t.prospect_id))];
  // The platform-rendered emails in the queue, so the card can show the proof the copy
  // is leading with — the founder is approving a claim about real money.
  const [prospects, bridgeRuns, signals] = await Promise.all([
    prospectsByIds(prospectIds),
    matchRunsForTouches(queue.map((t) => t.id)),
    signalsByProspectIds(prospectIds),
  ]);
  const now = new Date();

  const drafts: DraftCard[] = queue.map((t) => {
    const p = prospects.get(t.prospect_id) ?? null;
    const run = bridgeRuns.get(t.id) ?? null;
    return {
      touchId: t.id,
      hot: t.hot,
      channel: t.channel,
      bridge: run
        ? {
            requestId: run.bridge_row_uuid,
            state: run.state,
            matchCount: run.match_count,
            headlineTotalUsd: run.potential_total_usd,
            contentHashPresent: run.content_hash !== null,
            failureReason: run.failure_reason,
            companyName: run.company_name,
          }
        : null,
      templateVersion: t.template_version,
      generationProvider: t.generation_provider ?? null,
      generationModel: t.generation_model ?? null,
      angle: t.angle,
      persona: t.persona ?? p?.persona ?? null,
      subject: t.subject,
      body: t.body,
      connectNote: t.connect_note,
      founderEdited: t.founder_edited,
      dryRun: t.dry_run,
      age: humanAge(new Date(t.drafted_at), now),
      draftedAt: new Date(t.drafted_at).toISOString(),
      prospect: p,
      signals: (signals.get(t.prospect_id) ?? []).map((s) => ({
        engagementType: s.engagement_type,
        commentText: s.comment_text,
        detectedAt: new Date(s.detected_at).toISOString(),
        age: humanAge(new Date(s.detected_at), now),
        postUrl: s.post_url,
        postAuthor: s.author_name,
        postAuthorHeadline: s.author_headline,
        postExcerpt: s.content_text,
        postedAt: s.posted_at ? new Date(s.posted_at).toISOString() : null,
      })),
      searchUrl: p?.full_name
        ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(p.full_name)}`
        : null,
    };
  });

  return {
    drafts,
    filters: { ...filters, page: result.page },
    counts: result.counts,
    total: result.total,
    pages: result.pages,
    offset: result.offset,
  };
};

function touchIdFrom(value: FormDataEntryValue | null): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    const form = await request.formData();
    const id = touchIdFrom(form.get('touchId'));
    if (id === null) return fail(400, { message: 'that draft could not be identified' });

    const outcome = await approveTouch(id, locals.user!);
    return {
      // changed:false is the double-tap case: reported plainly, never as an error.
      ok: true,
      message: outcome.changed
        ? `Draft approved.${outcome.bridgeNote ? ` ${outcome.bridgeNote}` : ''}`
        : `Draft ${id}: ${outcome.note}.`,
    };
  },

  edit: async ({ request, locals }) => {
    const form = await request.formData();
    const id = touchIdFrom(form.get('touchId'));
    if (id === null) return fail(400, { message: 'that draft could not be identified' });

    const body = String(form.get('body') ?? '');
    if (!body.trim()) return fail(400, { message: 'the message body cannot be empty' });

    const rawSubject = form.get('subject');
    const input: { subject?: string | null; body: string; connectNote?: string | null } = { body };
    if (rawSubject !== null) {
      const subject = String(rawSubject);
      input.subject = subject.trim() === '' ? null : subject;
    }
    const rawNote = form.get('connect_note');
    if (rawNote !== null) {
      const note = String(rawNote).trim();
      if (note.length > 300)
        return fail(400, { message: 'the connection note must be 300 characters or fewer' });
      input.connectNote = note === '' ? null : note;
    }

    const outcome = await editTouch(id, input, locals.user!);
    return {
      ok: true,
      message: outcome.changed
        ? 'Changes saved. Review the updated message before approving.'
        : `Draft ${id}: ${outcome.note}.`,
    };
  },

  skip: async ({ request, locals }) => {
    const form = await request.formData();
    const id = touchIdFrom(form.get('touchId'));
    if (id === null) return fail(400, { message: 'that draft could not be identified' });

    const outcome = await skipTouch(id, locals.user!, 'skipped from the dashboard');
    return {
      ok: true,
      message: outcome.changed
        ? `Draft skipped.${outcome.bridgeNote ? ` ${outcome.bridgeNote}` : ''}`
        : `Draft ${id}: ${outcome.note}.`,
    };
  },

  batchApprove: async ({ request, locals }) => {
    const form = await request.formData();
    const ids = form
      .getAll('touchId')
      .map(touchIdFrom)
      .filter((id): id is number => id !== null);

    if (ids.length === 0)
      return fail(400, { message: 'there was nothing in the batch to approve' });

    const result = await approveMany(ids, locals.user!);
    const parts = [`Approved ${result.approved} draft(s).`];
    if (result.unchanged > 0) parts.push(`${result.unchanged} were already handled.`);
    return { ok: true, message: parts.join(' ') };
  },
};
