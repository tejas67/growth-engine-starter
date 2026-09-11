<script lang="ts">
  import '@fontsource-variable/dm-sans';
  import '../app.css';
  import { page } from '$app/stores';
  import Icon from '$lib/Icon.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  let { data, children }: { data: LayoutData; children: Snippet } = $props();
  const tabs = [
    { href: '/', label: 'Review', icon: 'inbox' },
    { href: '/sources', label: 'Sources', icon: 'search' },
    { href: '/metrics', label: 'Results', icon: 'chart' },
    { href: '/settings', label: 'Settings', icon: 'settings' },
  ];
  let path = $derived($page.url.pathname);
</script>

<svelte:head><title>Growth Engine · Growth</title><link rel="icon" href="/brand.svg" /></svelte:head>
{#if data.user}
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="app-header">
    <a class="brand" href="/" aria-label="Growth Engine home"
      ><img src="/brand.svg" alt="" width="32" height="32" /><strong>Growth Engine</strong><span
        class="brand-divider"
      ></span><span class="workspace-name">{data.businessName || 'Your workspace'}</span></a
    >
    <nav class="main-nav" aria-label="Main navigation">
      {#each tabs as tab}
        <a href={tab.href} aria-current={path === tab.href ? 'page' : undefined}>
          <Icon name={tab.icon} /><span>{tab.label}</span>
          {#if tab.href === '/' && data.counts?.drafts}<span class="nav-count"
              >{data.counts.drafts}</span
            >{/if}
        </a>
      {/each}
    </nav>
    <div class="account">
      <a class="send-status" href="/settings#sending"
        ><span class:live={data.sending} class="status-dot"></span>{data.sending
          ? 'Sending enabled'
          : 'Sending paused'}</a
      >
      <details class="account-menu">
        <summary aria-label="Account for {data.user}">{data.user.slice(0, 1).toUpperCase()}</summary
        >
        <div class="account-popover">
          <span>Signed in as <strong>{data.user}</strong></span>
          <form method="POST" action="/logout">
            <button type="submit"><Icon name="logout" /> Sign out</button>
          </form>
        </div>
      </details>
    </div>
  </header>
{/if}
{#if data.user && !data.profileReady}<div class="setup-banner">Welcome to your growth workspace. <a href="/settings">Set up your business and AI</a>, or <a href="/sources">try the demo</a>.</div>{/if}
<main id="main" class:authenticated={Boolean(data.user)}>{@render children()}</main>
