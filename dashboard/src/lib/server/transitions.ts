/**
 * The dashboard's ONLY route from a button press to a changed touch.
 *
 * Every state change goes through the engine's pure transition functions
 * (src/approval/state.ts) and is persisted through the engine's repository. The
 * dashboard decides nothing about approval semantics — it reads the row, hands it to
 * the pure function, and writes back whatever came out.
 *
 * When the transition reports `changed: false` (an already-approved touch tapped a
 * second time) NOTHING is written: no status change, no audit row, no send. The
 * caller gets the transition's own note back so the screen can say "already
 * approved" instead of raising an error at someone holding a phone.
 */
import { withTx } from '$db';
import { approve, edit, skip } from '$core/approval/state.js';
import type { TouchState, TransitionResult } from '$core/approval/state.js';
import { insertAudit, matchRunForTouch, persistTouchState } from '$core/repo/index.js';
import { pushApprovalForTouch, pushSkipForTouch } from '$core/pipeline/bridge_stage.js';
import { lockTouchForUpdate } from './queries.js';

export interface TransitionOutcome {
  touchId: number;
  changed: boolean;
  note: string;
  /**
   * What the platform said when we forwarded this decision. Present only for
   * product-proof emails, and shown to the founder verbatim — including the one answer
   * that needs them: "the numbers moved, look again".
   */
  bridgeNote?: string;
}

async function run(
  touchId: number,
  apply: (state: TouchState) => TransitionResult,
): Promise<TransitionOutcome> {
  return withTx(async (client) => {
    const state = await lockTouchForUpdate(touchId, client);
    if (!state) return { touchId, changed: false, note: 'that draft no longer exists' };

    const result = apply(state);
    if (!result.changed) {
      // Idempotent replay. Deliberately silent in the database.
      return { touchId, changed: false, note: result.note };
    }

    await persistTouchState(
      touchId,
      {
        status: result.touch.status,
        subject: result.touch.subject,
        body: result.touch.body,
        connectNote: result.touch.connectNote,
        contentHash: result.touch.contentHash,
        founderEdited: result.touch.founderEdited,
        approvedAt: result.touch.approvedAt,
        approvedBy: result.touch.approvedBy,
        skippedAt: result.touch.skippedAt,
      },
      client,
    );

    if (result.audit) {
      await insertAudit(
        {
          touchId: result.audit.touchId,
          actor: result.audit.actor,
          action: result.audit.action,
          beforeHash: result.audit.beforeHash,
          afterHash: result.audit.afterHash,
          detail: result.audit.detail,
        },
        client,
      );
    }

    return { touchId, changed: true, note: result.note };
  });
}

/**
 * Approve, then TELL THE PLATFORM.
 *
 * For a DM this is the whole story. For a product-proof email the bytes live on the
 * platform, so approval means posting the hash of the bytes we showed — and the
 * platform is entitled to say "those are stale". That answer comes straight back to
 * the founder rather than being retried silently, because the honest response to
 * stale numbers is to read the new ones.
 *
 * A bridge that is unreachable is not an error: the local approval stands and the
 * bridge cron forwards it later. Approving twice is idempotent on both sides.
 */
export async function approveTouch(
  touchId: number,
  actor: string,
  now = new Date(),
): Promise<TransitionOutcome> {
  const outcome = await run(touchId, (state) => approve(state, actor, now));
  if (!outcome.changed) return outcome;

  const pushed = await pushApprovalForTouch(touchId, actor);
  if (!pushed.applicable) return outcome;
  return { ...outcome, bridgeNote: pushed.note };
}

/**
 * Editing is refused for platform-rendered emails, on purpose.
 *
 * The platform holds those bytes and sends exactly them. If the founder edited the
 * copy here, our record of what was sent would disagree with what actually went out,
 * and every number downstream reads our record. Skipping is always available; changing
 * the wording is a template change, not a per-touch one.
 */
export async function editTouch(
  touchId: number,
  input: { subject?: string | null; body?: string; connectNote?: string | null },
  actor: string,
  now = new Date(),
): Promise<TransitionOutcome> {
  const bridgeRun = await matchRunForTouch(touchId);
  if (bridgeRun) {
    return {
      touchId,
      changed: false,
      note:
        'this email is written and sent by the platform from its own record, so it cannot be edited here — ' +
        'skip it if the wording is wrong',
    };
  }
  return run(touchId, (state) => edit(state, input, actor, now));
}

export async function skipTouch(
  touchId: number,
  actor: string,
  reason?: string,
  now = new Date(),
): Promise<TransitionOutcome> {
  const outcome = await run(touchId, (state) => skip(state, actor, now, reason));
  if (!outcome.changed) return outcome;

  const pushed = await pushSkipForTouch(touchId, reason ?? 'declined in the dashboard');
  if (!pushed.applicable) return outcome;
  return { ...outcome, bridgeNote: pushed.note };
}

/** Batch approve reuses the exact same per-touch idempotent path, one row at a time. */
export async function approveMany(
  touchIds: number[],
  actor: string,
  now = new Date(),
): Promise<{ approved: number; unchanged: number; notes: string[] }> {
  let approved = 0;
  let unchanged = 0;
  const notes: string[] = [];
  for (const id of touchIds) {
    const outcome = await approveTouch(id, actor, now);
    if (outcome.changed) {
      approved += 1;
    } else {
      unchanged += 1;
      notes.push(`draft ${id}: ${outcome.note}`);
    }
  }
  return { approved, unchanged, notes };
}
