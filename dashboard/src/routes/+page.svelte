<script lang="ts">
  import { enhance } from '$app/forms';
  import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { PageData, ActionData } from './$types';
  import Icon from '$lib/Icon.svelte';
  import {
    channelLabel,
    inboxUrl,
    initials,
    nextDraftId,
    personaLabel,
    signalVerb,
  } from '$lib/inbox';
  import { whenLocal } from '$lib/display';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let draft = $derived(data.drafts.find((d) => d.touchId === data.filters.draft) ?? data.drafts[0]);
  let editing = $state(false);
  let dirty = $state(false);
  let pending = $state(false);
  let actionNavigation = false;
  let notice = $state('');
  let failed = $state(false);
  let body = $state('');
  let note = $state('');
  let subject = $state('');
  let editorFor = $state<number | null>(null);

  $effect(() => {
    if (draft?.touchId !== editorFor) {
      editorFor = draft?.touchId ?? null;
      editing = false;
      dirty = false;
    }
  });
  $effect(() => {
    const message = notice || form?.message;
    const ok = notice ? !failed : form?.ok;
    if (message && ok) {
      const timer = setTimeout(() => {
        notice = '';
        form = null;
      }, 4500);
      return () => clearTimeout(timer);
    }
  });
  const link = (changes: Record<string, string | number | null>) =>
    inboxUrl('/', $page.url.searchParams, { page: data.filters.page, ...changes });
  function formAction(action: string) {
    const params = new URLSearchParams(link({ draft: draft?.touchId ?? null }).split('?')[1]);
    return '?/' + action + (params.size ? '&' + params : '');
  }
  function startEdit() {
    if (!draft) return;
    body = draft.body;
    note = draft.connectNote ?? '';
    subject = draft.subject ?? '';
    editing = true;
    dirty = false;
  }
  function cancelEdit() {
    if (dirty && !window.confirm('Discard your unsaved edits?')) return;
    editing = false;
    dirty = false;
  }
  beforeNavigate(({ cancel }) => {
    if (pending && !actionNavigation) {
      cancel();
      return;
    }
    if (editing && dirty && !window.confirm('Discard your unsaved edits?')) cancel();
  });

  const reviewAction: SubmitFunction = ({ formData, action, cancel }) => {
    if (pending) {
      cancel();
      return;
    }
    pending = true;
    const id = Number(formData.get('touchId'));
    const next = nextDraftId(
      data.drafts.map((d) => d.touchId),
      id,
    );
    const isEdit = action.searchParams.has('/edit');
    notice = '';
    return async ({ result, update }) => {
      try {
        if (result.type === 'error') {
          failed = true;
          notice = 'Could not save your decision. Try again; repeated approvals are safe.';
          return;
        }
        if (result.type === 'success' || result.type === 'failure') {
          failed = result.type === 'failure';
          notice = String(result.data?.message ?? '');
          if (failed) {
            await update({ reset: false, invalidateAll: false });
            return;
          }
          editing = false;
          dirty = false;
          actionNavigation = true;
          if (isEdit) await invalidateAll();
          else
            await goto(link({ draft: next }), {
              invalidateAll: true,
              noScroll: true,
              keepFocus: true,
            });
        } else await update();
      } finally {
        pending = false;
        actionNavigation = false;
      }
    };
  };
</script>

<svelte:head><title>Review · Growth Engine</title></svelte:head>

<div class="page-heading">
  <div>
    <h1>Review drafts</h1>
    <p class="lede">Review messages before they enter your outreach queue.</p>
  </div>
  <button class="quiet refresh-button" onclick={() => invalidateAll()} disabled={pending}
    ><Icon name="refresh" /> Refresh</button
  >
</div>

{#if notice || form?.message}
  <div class="flash toast" class:warn={notice ? failed : !form?.ok} role="status">
    <Icon name={failed ? 'pause' : 'check'} /><span>{notice || form?.message}</span>
    <button
      class="icon-button"
      aria-label="Dismiss notification"
      onclick={() => {
        notice = '';
        form = null;
      }}>×</button
    >
  </div>
{/if}

<div class="inbox" class:detail-open={Boolean(data.filters.draft)} aria-busy={pending}>
  <aside class="inbox-list" aria-label="Draft queue">
    <div class="list-controls">
      <form method="GET" class="search-form">
        <label for="search-drafts" class="field-caption">Find a prospect</label>
        <div class="search-input">
          <Icon name="search" /><input
            id="search-drafts"
            type="search"
            name="q"
            value={data.filters.q}
            placeholder="Name, company, or role"
          /><button class="icon-button" type="submit" aria-label="Search drafts"
            ><Icon name="arrow" /></button
          >
        </div>
        <input type="hidden" name="filter" value={data.filters.filter} />
        <div class="filter-row">
          <label
            >Channel<select
              name="channel"
              value={data.filters.channel}
              onchange={(event) => event.currentTarget.form?.requestSubmit()}
              ><option value="all">All channels</option><option value="dm">LinkedIn</option
              ></select
            ></label
          >
          <label
            >Sort<select
              name="sort"
              value={data.filters.sort}
              onchange={(event) => event.currentTarget.form?.requestSubmit()}
              ><option value="newest">Newest first</option><option value="oldest"
                >Oldest first</option
              ></select
            ></label
          >
        </div>
      </form>
      <nav class="filter-tabs" aria-label="Draft priority">
        <a
          href={link({ filter: null, page: 1, draft: null })}
          aria-current={data.filters.filter === 'all' ? 'page' : undefined}
          >All drafts <span>{data.counts.all}</span></a
        >
        <a
          href={link({ filter: 'priority', page: 1, draft: null })}
          aria-current={data.filters.filter === 'priority' ? 'page' : undefined}
          >Priority <span>{data.counts.priority}</span></a
        >
      </nav>
    </div>
    <div class="queue-rows">
      {#each data.drafts as item (item.touchId)}
        <a
          class="queue-row"
          class:selected={draft?.touchId === item.touchId}
          href={link({ draft: item.touchId })}
          aria-current={draft?.touchId === item.touchId ? 'true' : undefined}
        >
          <span class="avatar" aria-hidden="true">{initials(item.prospect?.full_name)}</span>
          <span class="row-content">
            <span class="row-title"
              ><strong>{item.prospect?.full_name ?? 'Name not captured'}</strong><time
                datetime={item.draftedAt}
                title={whenLocal(item.draftedAt)}>{item.age.replace(' ago', '')}</time
              ></span
            >
            <span class="row-company"
              >{item.prospect?.company_name ??
                item.prospect?.headline ??
                'Company not captured'}</span
            >

            <span class="row-meta"
              ><span>{channelLabel(item.channel)}</span>{#if item.prospect?.score != null}<span
                  title="Latest audience-fit score out of 100">Fit {item.prospect.score}</span
                >{/if}{#if item.hot}<span class="priority-label">Priority</span
                >{/if}{#if item.founderEdited}<span>Edited</span>{/if}</span
            >
          </span>
        </a>
      {:else}
        <div class="list-empty">
          <Icon name="search" size={26} />
          <h2>
            {data.filters.q || data.filters.channel !== 'all' || data.filters.filter !== 'all'
              ? 'No matching drafts'
              : 'You’re all caught up'}
          </h2>
          <p>
            {data.filters.q || data.filters.channel !== 'all' || data.filters.filter !== 'all'
              ? 'Try another search or clear your filters.'
              : 'Add prospects in Sources, then run the engine to create drafts.'}
          </p>
          {#if data.filters.q || data.filters.channel !== 'all' || data.filters.filter !== 'all'}<a
              class="btn"
              href="/">Clear filters</a
            >{/if}
        </div>
      {/each}
    </div>
    <div class="pagination">
      <span
        >{data.total ? data.offset + 1 : 0}–{Math.min(data.offset + data.drafts.length, data.total)} of
        {data.total}</span
      >
      <div>
        {#if data.filters.page > 1}<a
            class="icon-button"
            href={link({ page: data.filters.page - 1, draft: null })}
            aria-label="Previous page"><Icon name="back" /></a
          >{:else}<button class="icon-button" disabled aria-label="Previous page"
            ><Icon name="back" /></button
          >{/if}
        {#if data.filters.page < data.pages}<a
            class="icon-button"
            href={link({ page: data.filters.page + 1, draft: null })}
            aria-label="Next page"><Icon name="arrow" /></a
          >{:else}<button class="icon-button" disabled aria-label="Next page"
            ><Icon name="arrow" /></button
          >{/if}
      </div>
    </div>
  </aside>

  <section class="review-pane" aria-label="Selected draft">
    {#if draft}
      {#key draft.touchId}
        <header class="detail-header">
          <a class="mobile-back" href={link({ draft: null })}><Icon name="back" /> All drafts</a>
          <div class="person-heading">
            <div class="avatar large" aria-hidden="true">{initials(draft.prospect?.full_name)}</div>
            <div>
              <div class="detail-kicker">
                {channelLabel(draft.channel)} outreach {#if draft.hot}<span class="priority-label"
                    >Priority</span
                  >{/if}
              </div>
              <h2>{draft.prospect?.full_name ?? 'Name not captured'}</h2>
              <p>{draft.prospect?.company_name ?? 'Company not captured'}</p>
            </div>
            {#if draft.generationProvider !== 'demo' && (draft.prospect?.linkedin_url || draft.searchUrl)}<a
                class="btn quiet profile-link"
                href={draft.prospect?.linkedin_url ?? draft.searchUrl ?? '#'}
                target="_blank"
                rel="noreferrer noopener">Profile <Icon name="external" size={15} /></a
              >{/if}
          </div>
          {#if draft.prospect?.headline}<p class="person-headline">
              {draft.prospect.headline}
            </p>{/if}
          {#if draft.signals[0]}<p class="signal-summary">
              {signalVerb(draft.signals[0].engagementType)}
              {draft.signals[0].postAuthor ?? 'a tracked account'}’s post
              <span>· detected {draft.signals[0].age}</span>
            </p>{/if}
        </header>

        <div class="detail-scroll">
          {#if draft.channel !== 'email'}
            <div class="sender-line" aria-label="Sending account">
              <span class="muted">From</span>
              {#if data.sender?.profileUrl}<a href={data.sender.profileUrl} target="_blank" rel="noreferrer noopener">{data.sender.name ?? 'LinkedIn account'}</a>
              {:else}<strong>{data.sender?.name ?? 'Sender not verified'}</strong>{/if}
              <span class="muted">via LinkedIn · HeyReach</span>
              {#if data.sender && !data.sender.connected}<span class="sender-status">{data.sender.detail}</span>{/if}
            </div>
          {/if}
          {#if draft.prospect?.is_gov}<div class="inline-notice warning">
              Government contact. Check suitability before approving this draft.
            </div>{/if}
          {#if editing}
            <form
              method="POST"
              action={formAction('edit')}
              use:enhance={reviewAction}
              id="edit-draft"
              class="message-editor"
              oninput={() => (dirty = true)}
            >
              <input type="hidden" name="touchId" value={draft.touchId} />
              <div class="section-heading">
                <h3>Edit message</h3>
                <span class="muted">{dirty ? 'Unsaved changes' : 'Your wording'}</span>
              </div>
              {#if draft.subject !== null}<label for="edit-subject">Subject</label><input
                  id="edit-subject"
                  name="subject"
                  type="text"
                  bind:value={subject}
                  disabled={pending}
                />{/if}
              {#if draft.channel !== 'email'}<label for="edit-note"
                  >Connection note <span class="label-hint">{note.length}/300</span></label
                ><textarea
                  id="edit-note"
                  name="connect_note"
                  maxlength="300"
                  rows="3"
                  bind:value={note}
                  disabled={pending}></textarea>{/if}
              <label for="edit-body">Message</label><textarea
                id="edit-body"
                name="body"
                rows="9"
                bind:value={body}
                required
                disabled={pending}></textarea>
              <p class="note">Save your changes, then approve the exact wording.</p>
            </form>
          {:else}
            <section class="message-section" aria-label="Message to approve">
              <div class="section-heading">
                <h3>{draft.generationProvider === 'demo' ? 'Demo · cannot be sent' : 'Direct message'}</h3>
                {#if !draft.bridge}<button
                    class="quiet small"
                    onclick={startEdit}
                    disabled={pending}><Icon name="edit" size={15} /> Edit</button
                  >{/if}
              </div>
              {#if draft.subject !== null}<p class="message-subject">
                  <span class="muted">Subject</span>
                  {draft.subject}
                </p>{/if}
              <div class="message-text">{draft.body}</div>
              {#if draft.channel !== 'email'}
                <p class="note message-delivery-note">{draft.generationProvider === 'demo' ? 'Fictional example. Nothing will be sent.' : 'Your HeyReach campaign controls the timing and follow-ups.'}</p>
                <div class="connection-note">
                  <span class="field-caption"
                    >CONNECTION NOTE <span class="caption-hint">· if you’re not connected</span
                    ></span
                  >{#if draft.connectNote}<p class="message-text">{draft.connectNote}</p>{:else}<p
                      class="note"
                    >
                      No connection note drafted. Add a note before enabling a campaign that sends invitations.
                    </p>{/if}
                </div>
              {/if}
            </section>
          {/if}

          {#if draft.bridge}
            <details class="disclosure proof-details" open>
              <summary
                >Opportunity match <span>{draft.bridge.matchCount ?? 'Pending'} matches</span
                ></summary
              >
              <div class="disclosure-body">
                <p>
                  This email was written by Growth Engine from a match for {draft.bridge.companyName ??
                    'this company'}. The approved wording is sent as shown.
                </p>
                <dl class="facts">
                  <dt>Published value</dt>
                  <dd>
                    {draft.bridge.headlineTotalUsd
                      ? '$' + Number(draft.bridge.headlineTotalUsd).toLocaleString('en-US')
                      : 'Not published'}
                  </dd>
                </dl>
                {#if !draft.bridge.contentHashPresent}<p class="inline-notice warning">
                    The email is still being prepared. Approval will not send it yet.
                  </p>{/if}{#if draft.bridge.failureReason}<p class="note">
                    {draft.bridge.failureReason}
                  </p>{/if}
                <p class="note">
                  To change this platform-written email, skip it and update its template.
                </p>
              </div>
            </details>
          {/if}

          <details class="disclosure">
            <summary
              ><span>Why this person</span><span
                >{draft.signals.length
                  ? draft.signals.length +
                    ' recent signal' +
                    (draft.signals.length === 1 ? '' : 's')
                  : 'No signal recorded'}</span
              ></summary
            >
            <div class="disclosure-body">
              <p class="note">
                {personaLabel(draft.persona)}{draft.prospect?.score !== null &&
                draft.prospect?.score !== undefined
                  ? ' · Fit score ' + draft.prospect.score + '/100'
                  : ''}
              </p>
              {#each draft.signals as signal}
                <div class="signal">
                  <p>
                    <strong
                      >{signalVerb(signal.engagementType)}
                      {signal.postAuthor ?? 'a tracked account'}’s post</strong
                    ><span class="signal-age">Detected {signal.age}</span>
                  </p>
                  {#if signal.commentText}<blockquote>
                      {signal.commentText}
                    </blockquote>{/if}{#if signal.postExcerpt}<p class="source-excerpt">
                      {signal.postExcerpt}
                    </p>{/if}{#if signal.postUrl}<a
                      class="text-link"
                      href={signal.postUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      >Read original post <Icon name="external" size={14} /></a
                    >{/if}
                </div>
              {:else}<p class="note">No source engagement was recorded for this draft.</p>{/each}
            </div>
          </details>
          <details class="disclosure">
            <summary>Draft details <span>Source, model & verification</span></summary>
            <div class="disclosure-body">
              <dl class="facts">
                <dt>Created</dt>
                <dd>{whenLocal(draft.draftedAt)}</dd>
                <dt>Draft</dt>
                <dd>#{draft.touchId}{draft.founderEdited ? ' · Edited by you' : ''}</dd>
                <dt>Model</dt>
                <dd>
                  {draft.generationModel ?? 'Not recorded'}{draft.generationProvider
                    ? ' (' + draft.generationProvider + ')'
                    : ''}
                </dd>
                <dt>Template</dt>
                <dd>{draft.templateVersion}{draft.angle ? ' · ' + draft.angle : ''}</dd>
                <dt>Company</dt>
                <dd>
                  {draft.prospect?.company_domain ?? 'Domain not captured'} · {draft.prospect
                    ?.company_verified
                    ? 'Verified'
                    : 'Not verified'}
                </dd>
                <dt>Mode</dt>
                <dd>{draft.dryRun ? 'Dry run' : 'Live draft'}</dd>
              </dl>
              {#if draft.searchUrl}<a
                  class="text-link"
                  href={draft.searchUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  >Find another LinkedIn profile <Icon name="external" size={14} /></a
                >{/if}
            </div>
          </details>
        </div>

        <footer class="review-actions">
          {#if editing}
            <p class="action-note">Changes need your approval.</p>
            <div class="actions">
              <button onclick={cancelEdit} disabled={pending}>Cancel</button><button
                class="primary"
                type="submit"
                form="edit-draft"
                disabled={pending || !body.trim()}
                >{pending ? 'Saving…' : 'Save changes'}<Icon name="check" /></button
              >
            </div>
          {:else}
            <p class="action-note">
              {data.sending
                ? 'Approved drafts enter the sending queue.'
                : 'Sending is paused. Approvals stay queued.'}
            </p>
            <div class="actions">
              <form method="POST" action={formAction('skip')} use:enhance={reviewAction}>
                <input type="hidden" name="touchId" value={draft.touchId} /><button
                  type="submit"
                  disabled={pending}>Skip</button
                >
              </form>
              <form method="POST" action={formAction('approve')} use:enhance={reviewAction}>
                <input type="hidden" name="touchId" value={draft.touchId} /><button
                  class="primary"
                  type="submit"
                  disabled={pending}
                  >{pending ? 'Saving…' : 'Approve draft'}<Icon name="check" /></button
                >
              </form>
            </div>
          {/if}
        </footer>
      {/key}
    {:else}
      <div class="pane-empty">
        <Icon name="inbox" size={36} />
        <h2>
          {data.total === 0 &&
          !data.filters.q &&
          data.filters.channel === 'all' &&
          data.filters.filter === 'all'
            ? 'Room for the next conversation.'
            : 'No draft selected'}
        </h2>
        <p>
          {data.filters.q || data.filters.channel !== 'all' || data.filters.filter !== 'all'
            ? 'Try another search or clear your filters to see more prospects.'
            : 'The engine will keep finding prospects and preparing drafts.'}
        </p>
        <a class="text-link" href="/sources">Manage sources <Icon name="arrow" /></a>
      </div>
    {/if}
  </section>
</div>
