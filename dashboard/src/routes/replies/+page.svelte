<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { PageData, ActionData } from './$types';
  import Icon from '$lib/Icon.svelte';
  import { inboxUrl, initials, channelLabel } from '$lib/inbox';
  import { whenLocal } from '$lib/display';
  let { data, form }: { data: PageData; form: ActionData } = $props();
  let pending = $state(false);
  let error = $state('');
  $effect(() => {
    if (form?.ok && form.message) {
      const timer = setTimeout(() => {
        form = null;
      }, 4500);
      return () => clearTimeout(timer);
    }
  });
  const link = (changes: Record<string, string | number | null>) =>
    inboxUrl('/replies', $page.url.searchParams, { page: data.page, ...changes });
  function action(name: string) {
    const params = new URLSearchParams(link({ item: data.selected?.id ?? null }).split('?')[1]);
    return '?/' + name + '&' + params;
  }
  const save: SubmitFunction = ({ cancel }) => {
    if (pending) {
      cancel();
      return;
    }
    pending = true;
    error = '';
    return async ({ update, result }) => {
      try {
        if (result.type === 'error') error = 'Could not save that change. Please try again.';
        else await update({ reset: false });
      } finally {
        pending = false;
      }
    };
  };
  const verdicts = [
    { kind: 'positive_reply', label: 'Interested' },
    { kind: 'neutral_reply', label: 'Neutral' },
    { kind: 'negative_reply', label: 'Not interested' },
  ];
</script>

<svelte:head><title>Replies · Growth Engine</title></svelte:head>
<div class="page-heading">
  <div>
    <h1>Replies</h1>
    <p class="lede">Read the conversation. Follow up in Gmail or LinkedIn.</p>
  </div>
  <button class="quiet refresh-button" onclick={() => invalidateAll()} disabled={pending}
    ><Icon name="refresh" /> Refresh</button
  >
</div>
{#if error || form?.message}<div
    class="flash toast"
    class:warn={Boolean(error) || !form?.ok}
    role="status"
  >
    <span>{error || form?.message}</span><button
      class="icon-button"
      aria-label="Dismiss notification"
      onclick={() => {
        error = '';
        form = null;
      }}>×</button
    >
  </div>{/if}

<div class="inbox replies-inbox" class:detail-open={data.detailOpen} aria-busy={pending}>
  <aside class="inbox-list" aria-label="Reply inbox">
    <div class="list-controls">
      <form method="GET" class="search-form">
        <label class="field-caption" for="search-replies">Find a conversation</label>
        <div class="search-input">
          <Icon name="search" /><input
            id="search-replies"
            type="search"
            name="q"
            value={data.query}
            placeholder="Name, company, or sender"
          /><button class="icon-button" type="submit" aria-label="Search replies"
            ><Icon name="arrow" /></button
          >
        </div>
        <input type="hidden" name="view" value={data.view} />
      </form>
      <nav class="filter-tabs" aria-label="Reply type">
        <a
          href={link({ view: null, page: 1, item: null })}
          aria-current={data.view === 'conversations' ? 'page' : undefined}
          >Conversations <span>{data.counts.conversations}</span></a
        ><a
          href={link({ view: 'unmatched', page: 1, item: null })}
          aria-current={data.view === 'unmatched' ? 'page' : undefined}
          >Unmatched <span>{data.counts.unmatched}</span></a
        >
      </nav>
    </div>
    <div class="queue-rows">
      {#each data.items as item (item.id)}
        <a
          class="queue-row"
          class:selected={data.selected?.id === item.id}
          href={link({ item: item.id })}
          aria-current={data.selected?.id === item.id ? 'true' : undefined}
        >
          <span class="avatar" aria-hidden="true"
            >{data.view === 'conversations' ? initials(item.name) : '@'}</span
          ><span class="row-content">
            <span class="row-title"
              ><strong>{item.name}</strong><time datetime={item.at}
                >{item.age.replace(' ago', '')}</time
              ></span
            >
            <span class="row-company"
              >{data.view === 'conversations'
                ? (item.companyName ?? item.email ?? 'Company not captured')
                : (item.subject ?? 'No subject')}</span
            >
            <span class="row-preview"
              >{item.excerpt?.slice(0, 160) ?? 'Open the conversation to read the reply.'}</span
            ></span
          >
        </a>
      {:else}
        <div class="list-empty">
          <Icon name="reply" size={28} />
          <h2>
            {data.query
              ? 'No matching conversations'
              : data.view === 'unmatched'
                ? 'Nothing unmatched'
                : 'No replies yet'}
          </h2>
          <p>
            {data.query
              ? 'Try another name or clear your search.'
              : data.view === 'unmatched'
                ? 'Mail without a matching outreach message appears here.'
                : 'Replies to your outreach will appear here.'}
          </p>
          {#if data.query}<a class="btn" href={link({ q: null, page: 1 })}>Clear search</a>{/if}
        </div>
      {/each}
    </div>
    <div class="pagination">
      <span
        >{data.total ? data.offset + 1 : 0}–{Math.min(data.offset + data.items.length, data.total)} of
        {data.total}</span
      >
      <div>
        {#if data.page > 1}<a
            class="icon-button"
            href={link({ page: data.page - 1, item: null })}
            aria-label="Previous page"><Icon name="back" /></a
          >{:else}<button class="icon-button" disabled aria-label="Previous page"
            ><Icon name="back" /></button
          >{/if}{#if data.page < data.pages}<a
            class="icon-button"
            href={link({ page: data.page + 1, item: null })}
            aria-label="Next page"><Icon name="arrow" /></a
          >{:else}<button class="icon-button" disabled aria-label="Next page"
            ><Icon name="arrow" /></button
          >{/if}
      </div>
    </div>
  </aside>
  <section class="review-pane" aria-label="Selected conversation">
    {#if data.selected}
      <header class="detail-header">
        <a class="mobile-back" href={link({ item: null })}><Icon name="back" /> {data.view === 'unmatched' ? 'Unmatched mail' : 'All conversations'}</a
        >
        <div class="person-heading">
          <div class="avatar large" aria-hidden="true">
            {data.view === 'conversations' ? initials(data.selected.name) : '@'}
          </div>
          <div>
            <div class="detail-kicker">
              {data.view === 'unmatched' ? 'Unmatched email' : 'Conversation'}
            </div>
            <h2>{data.selected.name}</h2>
            <p>{data.selected.companyName ?? data.selected.email ?? ''}</p>
          </div>
          {#if data.replies[0]?.gmailUrl}<a
              class="btn primary profile-link"
              href={data.replies[0].gmailUrl}
              target="_blank"
              rel="noreferrer noopener">Open Gmail <Icon name="external" size={15} /></a
            >{:else if data.replies[0]?.channel !== 'email' && data.selected.linkedinUrl}<a
              class="btn primary profile-link"
              href={data.selected.linkedinUrl}
              target="_blank"
              rel="noreferrer noopener">Open LinkedIn <Icon name="external" size={15} /></a
            >{/if}
        </div>
        {#if data.selected.paused}<p class="person-headline">
            <Icon name="pause" size={13} /> Follow-ups paused after their reply.
          </p>{/if}
      </header>
      <div class="detail-scroll">
        {#if data.view === 'unmatched'}<div class="inline-notice">
            This email hasn’t been linked to an outreach message. It may be unrelated mail. Check
            the original thread in Gmail.
          </div>{/if}
        {#each data.replies as reply (reply.eventId)}
          <article class="reply-message">
            <div class="section-heading">
              <h3>
                {channelLabel(reply.channel)}{data.view === 'unmatched' ? ' message' : ' reply'}
              </h3>
              <time class="muted" datetime={reply.occurredAt} title={whenLocal(reply.occurredAt)}
                >{reply.age}</time
              >
            </div>
            {#if reply.subject}<p class="message-subject">{reply.subject}</p>{/if}
            {#if reply.excerpt}<div class="message-text">{reply.excerpt}</div>{:else}<p
                class="note"
              >
                Message text wasn’t captured. Open the original conversation to read it.
              </p>{/if}
            {#if reply.gmailUrl && data.replies.length > 1}<a
                class="text-link"
                href={reply.gmailUrl}
                target="_blank"
                rel="noreferrer noopener"
                >Open this thread in Gmail <Icon name="external" size={14} /></a
              >{/if}
            {#if !reply.gmailUrl && reply.channel === 'email'}<p class="note reply-link-note">
                No direct Gmail link was captured. Find the thread in your inbox by sender or
                subject.
              </p>{/if}
            {#if data.view === 'conversations'}
              <div class="reply-verdict">
                <p class="field-caption">REPLY OUTCOME</p>
                <div class="actions">
                  {#each verdicts as verdict}<form
                      method="POST"
                      action={action('classify')}
                      use:enhance={save}
                    >
                      <input type="hidden" name="eventId" value={reply.eventId} /><input
                        type="hidden"
                        name="kind"
                        value={verdict.kind}
                      /><button
                        type="submit"
                        class:chosen={reply.founderVerdict === verdict.kind}
                        aria-pressed={reply.founderVerdict === verdict.kind}
                        disabled={pending}
                        >{#if reply.founderVerdict === verdict.kind}<Icon
                            name="check"
                            size={14}
                          />{/if}{verdict.label}</button
                      >
                    </form>{/each}
                </div>
                {#if reply.founderVerdict}<p class="note">Your assessment is recorded.</p>{/if}
              </div>
            {/if}
          </article>
        {/each}
        {#if data.replies.length === 100}<p class="note">
            Showing the 100 most recent messages in this conversation.
          </p>{/if}
        {#if data.view === 'conversations'}
          <details class="disclosure">
            <summary>Contact preferences</summary>
            <div class="disclosure-body">
              <p class="note">
                If they asked you to stop, permanently block future outreach to every email and
                profile we hold for them.
              </p>
              <form method="POST" action={action('notInterested')} use:enhance={save}>
                <input type="hidden" name="prospectId" value={data.selected.id} /><button
                  class="danger"
                  type="submit"
                  disabled={pending}>Block future outreach</button
                >
              </form>
            </div>
          </details>
        {/if}
      </div>

      <footer class="review-actions mobile-reply-actions">
        <p class="action-note">Reply in the original conversation.</p>
        {#if data.replies[0]?.gmailUrl}
          <a
            class="btn primary"
            href={data.replies[0].gmailUrl}
            target="_blank"
            rel="noreferrer noopener">Open Gmail <Icon name="external" size={15} /></a
          >
        {:else if data.replies[0]?.channel !== 'email' && data.selected.linkedinUrl}
          <a
            class="btn primary"
            href={data.selected.linkedinUrl}
            target="_blank"
            rel="noreferrer noopener">Open LinkedIn <Icon name="external" size={15} /></a
          >
        {:else}<span class="note">Find the thread in your inbox.</span>{/if}
      </footer>
    {:else}
      <div class="pane-empty">
        <Icon name="reply" size={36} />
        <h2>{data.query ? 'No matching conversation' : 'Conversations start here.'}</h2>
        <p>
          {data.query
            ? 'Try searching by company or sender.'
            : 'When someone replies to your outreach, read their message here and follow up in the original thread.'}
        </p>
        <a class="text-link" href="/">Review drafts <Icon name="arrow" /></a>
      </div>
    {/if}
  </section>
</div>
{#if data.paused.length}
  <details class="disclosure paused-list">
    <summary
      >Paused follow-ups <span
        >{data.paused.length === 100 ? 'Latest 100' : data.paused.length} people</span
      ></summary
    >
    <div class="disclosure-body">
      <p class="note">These sequences are stopped while you review the conversation.</p>
      <div class="table-wrap">
        <table>
          <thead
            ><tr
              ><th scope="col">Person</th><th scope="col">Company</th><th scope="col">Paused</th><th
                scope="col">Reason</th
              ></tr
            ></thead
          ><tbody
            >{#each data.paused as person}<tr
                ><td>{person.name}</td><td>{person.companyName ?? '—'}</td><td
                  >{person.pausedAge}</td
                ><td>{person.reason ?? '—'}</td></tr
              >{/each}</tbody
          >
        </table>
      </div>
    </div>
  </details>
{/if}
