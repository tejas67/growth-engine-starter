/**
 * Metrics — the experiment, read honestly.
 *
 * Every number on this page comes from the engine's own metrics module, so the
 * dashboard and the daily digest can never quietly disagree. The rules the module
 * enforces are restated in the UI rather than hidden:
 *  - one predeclared primary metric (positive-reply rate) cut one predeclared way
 *    (persona); everything else is exploratory and labelled as such,
 *  - a cell below the reporting floor shows COUNTS ONLY, never a rate,
 *  - graduation is per template AND persona, never aggregated, and only ever a
 *    recommendation — the founder throws the switch.
 */
import type { Actions, ServerLoad } from '@sveltejs/kit';
import { config } from '$config';
import {
  buildFunnel,
  cutBy,
  graduationVerdicts,
  SELECTION_BIAS_NOTE,
} from '$core/metrics/funnels.js';
import { getLaneState, setLaneState } from '$core/repo/index.js';
import { eventFacts, seedSlugs, touchFacts } from '$lib/server/queries';
import type { MetricCut } from '$lib/types';

interface KillSwitch {
  sending_enabled?: boolean;
}
interface EmailRestriction {
  mode?: string;
  tripped_at?: string;
}
interface LinkedInCampaign {
  paused?: boolean;
  reason?: string;
}

export const load: ServerLoad = async () => {
  const [touches, events, seeds] = await Promise.all([touchFacts(), eventFacts(), seedSlugs()]);

  const minN = config.dashboard.minCellN;

  const primary: MetricCut = {
    title: 'Interested replies by audience',
    description: 'The primary experiment measure: how often each audience replies with interest.',
    exploratory: false,
    cells: cutBy(touches, events, (t) => t.persona, minN),
  };

  const exploratory: MetricCut[] = [
    {
      title: 'By message template',
      description: 'Which version of the message was used.',
      exploratory: true,
      cells: cutBy(touches, events, (t) => t.templateVersion, minN),
    },
    {
      title: 'By angle',
      description: 'Which opening line the message led with.',
      exploratory: true,
      cells: cutBy(touches, events, (t) => t.angle, minN),
    },
    {
      title: 'By the account whose post they engaged with',
      description: 'Where we first noticed this person.',
      exploratory: true,
      cells: cutBy(
        touches,
        events,
        (t) =>
          t.seedAccountId === null ? null : (seeds.get(t.seedAccountId) ?? `#${t.seedAccountId}`),
        minN,
      ),
    },
    {
      title: 'By what they did',
      description: 'Liked, commented, reposted, or several of those.',
      exploratory: true,
      cells: cutBy(touches, events, (t) => t.signalType, minN),
    },
    {
      title: 'By how quickly we followed up',
      description: 'Time from us noticing the signal to the message going out.',
      exploratory: true,
      cells: cutBy(touches, events, (t) => t.latencyBucket, minN),
    },
  ];

  const [killSwitch, emailRestriction, linkedinCampaign] = await Promise.all([
    getLaneState<KillSwitch>('kill_switch', { sending_enabled: false }),
    getLaneState<EmailRestriction>('email_lane_restriction', { mode: 'all' }),
    getLaneState<LinkedInCampaign>('linkedin_campaign', { paused: false }),
  ]);

  return {
    minN,
    funnels: [
      buildFunnel('dm', touches, events, minN),
    ],
    primary,
    exploratory,
    graduation: graduationVerdicts(touches, events),
    graduationBar: {
      minSends: config.graduation.minSends,
      minRate: config.graduation.minPositiveReplyRate,
    },
    selectionBiasNote: SELECTION_BIAS_NOTE,
    lanes: {
      sendingEnabled: killSwitch.sending_enabled === true,
      dryRun: config.dryRun,
      dmEnabled: config.send.dmEnabled,
      emailEnabled: config.send.emailEnabled,
      emailMode: emailRestriction.mode ?? 'all',
      emailTrippedAt: emailRestriction.tripped_at ?? null,
      linkedinPaused: linkedinCampaign.paused === true,
      linkedinReason: linkedinCampaign.reason ?? null,
    },
  };
};

export const actions: Actions = {
  /**
   * One direction only: OFF.
   *
   * Stopping sending is an emergency and belongs on a button. Starting sending is a
   * deliberate act with a checklist behind it, and it happens in the configuration on
   * the server — never on a phone, never with one tap, never by accident.
   */
  disableSending: async ({ locals }) => {
    const current = await getLaneState<KillSwitch>('kill_switch', { sending_enabled: false });
    if (current.sending_enabled !== true) {
      return { ok: true, message: 'Sending was already off. Nothing changed.' };
    }
    await setLaneState(
      'kill_switch',
      { sending_enabled: false, disabled_by: locals.user, disabled_at: new Date().toISOString() },
      locals.user!,
    );
    return {
      ok: true,
      message:
        'Sending is now off. Nothing further will go out until it is turned back on in Settings.',
    };
  },
};
