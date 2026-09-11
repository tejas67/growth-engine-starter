<script lang="ts">
  import { page } from '$app/stores';
  import Icon from '$lib/Icon.svelte';
</script>

<svelte:head><title>Unable to load · Growth Engine</title></svelte:head>
<div class="pane-empty error-page">
  <Icon name="inbox" size={36} />
  <h1>{$page.status === 404 ? 'Page not found' : 'This view couldn’t load'}</h1>
  <p>
    {$page.status === 404
      ? 'This link doesn’t point to a page in your workspace.'
      : 'Try loading the page again to continue.'}
  </p>
  <div class="actions">
    {#if $page.status !== 404}<a
        class="btn"
        href={$page.url.pathname + $page.url.search}
        data-sveltekit-reload>Try again</a
      >{/if}<a class="btn primary" href="/">Back to review <Icon name="arrow" /></a>
  </div>
</div>

<style>
  .error-page {
    margin: 80px auto;
  }
</style>
