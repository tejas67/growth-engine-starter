<script lang="ts">
  let {
    data,
    form,
  }: {
    data: { configured: boolean; notConfiguredMessage: string; user: string };
    form: { message?: string } | null;
  } = $props();
</script>

<svelte:head><title>Sign in · Growth Engine</title></svelte:head>
<div class="login">
  <div class="brand">
    <img src="/brand.svg" alt="" width="36" height="36" /><strong>Growth Engine</strong>
  </div>
  <h1>Sign in to Growth</h1>
  <p class="lede">Your outreach workspace.</p>
  {#if !data.configured}<div class="flash warn" role="alert">{data.notConfiguredMessage}</div>{/if}
  {#if form?.message}<div class="flash warn" role="alert">{form.message}</div>{/if}
  <form method="POST">
    <label for="user">Username</label><input
      id="user"
      name="user"
      type="text"
      autocomplete="username"
      value={data.user}
      required
    /><label for="password">Password</label><input
      id="password"
      name="password"
      type="password"
      autocomplete="current-password"
      required
      disabled={!data.configured}
    /><button class="primary" type="submit" disabled={!data.configured}>Sign in</button>
  </form>
  <p class="login-footnote">Private workspace · Growth Engine</p>
</div>
