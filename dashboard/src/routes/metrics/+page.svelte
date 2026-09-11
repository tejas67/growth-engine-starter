<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/stores';
  import { pct } from '$lib/display';
  import { personaLabel } from '$lib/inbox';
  import Icon from '$lib/Icon.svelte';
  import type { MetricCut } from '$lib/types';
  import type { PageData, ActionData } from './$types';
  let { data, form }: { data: PageData; form: ActionData } = $props();
  let pending = $state(false);
  const stageLabel: Record<string, string> = {
    sent: 'Sent',
    clicked: 'Clicked',
    claimed: 'Claimed company',
    activated: 'Activated',
    reply: 'Replied',
    positive_reply: 'Interested',
    signed_in: 'Signed up',
  };
  const readiness: Record<string, string> = {
    graduate: 'Ready to scale',
    keep_testing: 'Keep testing',
    kill: 'Stop using',
    insufficient_data: 'More sends needed',
  };
  let totalSent = $derived(data.funnels.reduce((n, f) => n + f.n, 0));
  let templateSends = $derived(data.primary.cells.reduce((n, c) => n + c.sends, 0));
  let templateReplies = $derived(data.primary.cells.reduce((n, c) => n + c.replies, 0));
  let templatePositive = $derived(data.primary.cells.reduce((n, c) => n + c.positive, 0));
  let selectedCut = $derived(
    Math.max(0, Math.min(4, Number($page.url.searchParams.get('cut')) || 0)),
  );
  const cutLabels = ['Message', 'Opening', 'Source', 'Signal', 'Timing'];
</script>

<svelte:head><title>Results · Growth Engine</title></svelte:head>
<div class="page-heading">
  <div>
    <h1>Results</h1>
    <p class="lede">Track replies and learn which messages earn interest.</p>
  </div>
  <span class="period-label">All time <span>·</span> Live sends only</span>
</div>
{#if form?.message}<div class="flash" class:warn={!form?.ok} role="status">{form.message}</div>{/if}

<div class="results-layout">
  <div class="results-main">
    {#if totalSent === 0}
      <section class="results-empty">
        <p class="eyebrow">THE EXPERIMENT IS GETTING STARTED</p>
        <h2>No live sends yet.</h2>
        <p>
          Your drafts are ready to review. Once outreach begins, this is where you’ll see who
          replies and which messages work.
        </p>
        <a class="btn primary" href="/">Review drafts <Icon name="arrow" /></a>
        <div class="empty-steps">
          <span><span>1</span> Review drafts</span><Icon name="chevron" size={14} /><span
            ><span>2</span> Approve messages</span
          ><Icon name="chevron" size={14} /><span><span>3</span> Send & learn</span>
        </div>
      </section>
    {:else}
      <section class="result-totals" aria-label="Outreach totals">
        <div>
          <p>Live messages sent</p>
          <strong>{totalSent}</strong><span>Confirmed LinkedIn sends</span>
        </div>
        <div>
          <p>Template replies</p>
          <strong>{templateReplies}</strong><span>From {templateSends} unedited sends</span>
        </div>
        <div>
          <p>Interested replies</p>
          <strong>{templatePositive}</strong><span>From {templateSends} unedited sends</span>
        </div>
      </section>
      <section class="results-section">
        <div class="results-section-heading">
          <h2>Interested replies by audience</h2>
          <span class="tag">Primary measure</span>
        </div>
        <p class="note">
          Rates appear after {data.minN} sends per audience. Rewritten messages are excluded.
        </p>
        {@render cutTable(data.primary, true)}
      </section>
    {/if}

    <section class="results-section">
      <div class="results-section-heading">
        <h2>Channel performance</h2>
        <span class="muted">{totalSent} live sends</span>
      </div>
      <div class="channel-grid">
        {#each data.funnels as funnel}
          <section class="channel-funnel">
            <h3>
              <Icon name={funnel.lane === 'email' ? 'mail' : 'reply'} />{funnel.lane === 'email'
                ? 'Email'
                : 'LinkedIn'}
            </h3>
            <div class="funnel-stages">
              {#each funnel.stages as stage}<div class="funnel-stage">
                  <span>{stageLabel[stage.name] ?? stage.name}</span><strong>{stage.count}</strong
                  ><span class="funnel-rate">{stage.rate === null ? '—' : pct(stage.rate)}</span>
                </div>{/each}
            </div>
          </section>
        {/each}
      </div>
      <p class="note section-footnote">
        Rates compare each step with the previous one and stay hidden below {data.minN} sends.
      </p>
    </section>

    {#if totalSent > 0}
      <details
        class="disclosure results-disclosure"
        id="explore"
        open={$page.url.searchParams.has('cut')}
      >
        <summary>Explore performance <span>Secondary comparisons</span></summary>
        <div class="disclosure-body">
          <p class="note">
            Use these as leads for the next experiment. They are exploratory, not proven findings.
          </p>
          <nav class="filter-tabs" aria-label="Compare performance by">
            {#each cutLabels as label, i}<a
                href={'/metrics?cut=' + i + '#explore'}
                aria-current={selectedCut === i ? 'page' : undefined}>{label}</a
              >{/each}
          </nav>
          <p class="note cut-description">{data.exploratory[selectedCut].description}</p>
          {@render cutTable(data.exploratory[selectedCut])}
        </div>
      </details>
      <details class="disclosure results-disclosure">
        <summary>Template readiness <span>Recommendations only</span></summary>
        <div class="disclosure-body">
          <p class="note">
            A template needs {data.graduationBar.minSends} sends and {(
              data.graduationBar.minRate * 100
            ).toFixed(0)}% interested replies within each audience. Rewritten messages are excluded.
          </p>
          {#if data.graduation.length}<div class="table-wrap">
              <table>
                <thead
                  ><tr
                    ><th scope="col">Template / audience</th><th scope="col" class="num">Sent</th
                    ><th scope="col" class="num">Interested</th><th scope="col">Recommendation</th
                    ></tr
                  ></thead
                ><tbody
                  >{#each data.graduation as item}<tr
                      ><td
                        >{item.templateVersion}<span class="table-subtitle"
                          >{personaLabel(item.persona)}</span
                        ></td
                      ><td class="num">{item.sends}</td><td class="num">{item.positive}</td><td
                        >{readiness[item.recommendation] ?? item.recommendation}<span
                          class="table-subtitle">{item.note}</span
                        ></td
                      ></tr
                    >{/each}</tbody
                >
              </table>
            </div>{:else}<p class="empty">No template has live sends to assess yet.</p>{/if}
        </div>
      </details>
    {/if}
    <details class="disclosure results-disclosure">
      <summary>How to read these numbers</summary>
      <div class="disclosure-body">
        <p>
          The main measure is interested replies by audience. A small sample shows counts without
          rates. Templates are assessed separately for each audience, and recommendations never turn
          on sending.
        </p>
        <p class="note">{data.selectionBiasNote}</p>
      </div>
    </details>
  </div>
  <aside class="sending-panel" id="sending" aria-label="Sending controls">
    <div class="section-heading">
      <h2>Sending</h2>
      <span class="status-label" class:is-live={data.sending}
        ><span class="status-dot" class:live={data.sending}></span>{data.sending
          ? 'Enabled'
          : 'Paused'}</span
      >
    </div>
    <p>
      {data.sending
        ? 'Approved messages can enter active channels.'
        : 'You can keep reviewing. Approved messages stay queued until sending is enabled.'}
    </p>
    <dl class="sending-lanes">
      <div>
        <dt>LinkedIn</dt>
        <dd>
          {data.sending && data.lanes.dmEnabled && !data.lanes.linkedinPaused
            ? 'Enabled'
            : 'Paused'}
        </dd>
      </div>
      <div>
        <dt>Email</dt>
        <dd>{data.sending && data.lanes.emailEnabled ? 'Enabled' : 'Paused'}</dd>
      </div>
      {#if data.lanes.dryRun}<div>
          <dt>Mode</dt>
          <dd>Dry run</dd>
        </div>{/if}
    </dl>
    {#if data.lanes.linkedinReason}<p class="note">{data.lanes.linkedinReason}</p>{/if}
    {#if data.lanes.emailMode !== 'all'}<p class="note">
        Email is limited to {data.lanes.emailMode === 'good_only'
          ? 'verified addresses'
          : data.lanes.emailMode}.
      </p>{/if}
    <form
      method="POST"
      action="?/disableSending"
      use:enhance={() => {
        pending = true;
        return async ({ update }) => {
          try {
            await update();
          } finally {
            pending = false;
          }
        };
      }}
    >
      <button class="danger" type="submit" disabled={!data.lanes.sendingEnabled || pending}
        ><Icon name="pause" size={15} />{pending ? 'Pausing…' : 'Pause all sending'}</button
      >
    </form>
    <p class="sending-footnote">Enable new handoffs in Settings. Delivery and replies are confirmed in HeyReach.</p>
  </aside>
</div>

{#snippet cutTable(cut: MetricCut, audience = false)}
  {#if !cut.cells.length}<div class="empty">
      No eligible live sends in this comparison yet.
    </div>{:else}<div class="table-wrap">
      <table>
        <thead
          ><tr
            ><th scope="col">{audience ? 'Audience' : 'Group'}</th><th class="num" scope="col"
              >Sent</th
            ><th class="num" scope="col">Replied</th><th class="num" scope="col">Interested</th><th
              class="num"
              scope="col">Interest rate</th
            ></tr
          ></thead
        ><tbody
          >{#each cut.cells as cell}<tr
              ><td>{audience ? personaLabel(cell.key) : cell.key}</td><td class="num"
                >{cell.sends}</td
              ><td class="num">{cell.replies}</td><td class="num">{cell.positive}</td><td
                class="num"
                >{#if cell.belowFloor}<span
                    class="muted"
                    title={'At least ' + data.minN + ' sends needed'}>—</span
                  >{:else}{pct(cell.positiveRate)}{/if}</td
              ></tr
            >{/each}</tbody
        >
      </table>
    </div>{/if}
{/snippet}
