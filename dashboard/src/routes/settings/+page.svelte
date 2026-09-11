<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types';
  let { data, form }: { data: PageData; form: ActionData } = $props();
  let pending = $state(false);
  let provider = $state(untrack(()=>data.settings.ai.provider));
  let fallback = $state(untrack(()=>data.settings.ai.fallback));
  const providerKey = (id:string) => ({openai:'OPENAI_API_KEY',anthropic:'ANTHROPIC_API_KEY',compatible:'COMPATIBLE_API_KEY'}[id]);
  const providers = [{id:'demo',name:'Demo · no AI calls'},{id:'codex',name:'Codex · local ChatGPT login'},{id:'claude',name:'Claude Code · local login'},{id:'openai',name:'OpenAI · API key'},{id:'anthropic',name:'Anthropic · API key'},{id:'compatible',name:'Compatible API · local or hosted'}];
  const finish = () => { pending=true; return async ({update}:any) => { await update({reset:false}); pending=false; }; };
</script>
<svelte:head><title>Settings · Growth Engine</title></svelte:head>
<div class="setup-page">
  <div class="setup-heading"><div><p class="eyebrow">Your workspace</p><h1>Make it yours.</h1><p>Tell the engine who you help and what makes a conversation worthwhile.</p></div><a class="btn" href="/sources">Manage sources →</a></div>
  {#if form?.message}<div class="flash toast" role="status">{form.message}</div>{/if}
  <form method="POST" action="?/save" use:enhance={finish}>
    <section class="setup-section" id="business">
      <div class="section-intro"><span class="step-number">01</span><h2>Your business</h2><p>These details guide targeting and every draft. Be concrete. A narrow audience is easier to write for.</p></div>
      <div class="field-stack">
        <div class="field-grid"><label>Business name<input name="name" value={data.settings.business.name} required maxlength="120" placeholder="Your business" /></label><label>Sender’s name<input name="senderName" value={data.settings.business.senderName} required maxlength="120" placeholder="Your name" /></label></div>
        <label>Website <span class="optional">optional</span><input name="website" value={data.settings.business.website} maxlength="300" placeholder="https://your-business.example" /></label>
        <label>What do you do?<textarea name="description" rows="2" maxlength="3000" value={data.settings.business.description} placeholder="Explain it as you would to a new customer."></textarea></label>
        <label>Who is a good fit?<textarea name="audience" required rows="3" maxlength="3000" value={data.settings.business.audience} placeholder="Their role, kind of business, situation, and the problem you help solve. Include any locations or exclusions that matter."></textarea></label>
        <label>What can you offer in the first conversation?<textarea name="offer" required rows="3" maxlength="2000" value={data.settings.business.offer} placeholder="A specific, useful offer you can actually deliver. What would they get out of replying?"></textarea></label>
        <label>Evidence you can stand behind <span class="optional">optional</span><textarea name="proof" rows="3" maxlength="3000" value={data.settings.business.proof} placeholder="Real results, relevant experience, or examples. Leave blank if you do not have them yet."></textarea><small>The engine must not invent proof or imply you already did work for a prospect.</small></label>
        <details><summary>Writing preferences and exclusions</summary><div class="field-stack"><label>How should you sound?<textarea name="writingStyle" rows="3" maxlength="2000" value={data.settings.business.writingStyle}></textarea></label><label>Companies to exclude <span class="optional">one per line</span><textarea name="excludedCompanies" rows="3" value={data.settings.business.excludedCompanies.join('\n')}></textarea></label><label>Additional phrases to avoid <span class="optional">one per line</span><textarea name="bannedPhrases" rows="3" value={data.settings.business.bannedPhrases.join('\n')}></textarea></label></div></details>
      </div>
    </section>
    <section class="setup-section" id="ai">
      <div class="section-intro"><span class="step-number">02</span><h2>Your AI</h2><p>Use an account on this computer, an API key, or a local model. Your subscription and provider limits apply.</p></div>
      <div class="field-stack">
        <div class="field-grid"><label>Primary provider<select name="provider" bind:value={provider}>{#each providers as p}<option value={p.id}>{p.name}</option>{/each}</select></label><label>Model<input name="model" value={data.settings.ai.model} placeholder="API model ID; blank uses CLI default" maxlength="150" /></label></div>
        <small>For Codex, install it and run <code>codex login</code> on this computer. For Claude Code, run <code>claude auth login</code>. The app uses your local login without copying it into the repo.</small>
        <div class="field-grid"><label>When the primary hits a usage limit<select name="fallback" bind:value={fallback}><option value="none">Pause until available</option>{#each providers.filter(p=>p.id!=='demo') as p}<option value={p.id}>{p.name}</option>{/each}</select></label><label>Fallback model<input name="fallbackModel" value={data.settings.ai.fallbackModel} placeholder="API model ID; blank uses CLI default" maxlength="150" /></label></div>
        {#if provider === 'compatible' || fallback === 'compatible'}<label>Compatible API base URL<input name="compatibleBaseUrl" value={data.settings.ai.compatibleBaseUrl} placeholder="http://127.0.0.1:11434/v1" /><small>Used only for the Compatible API option. Choose a model installed on that server.</small></label>{:else}<input type="hidden" name="compatibleBaseUrl" value={data.settings.ai.compatibleBaseUrl} />{/if}
        {#each ['OPENAI_API_KEY','ANTHROPIC_API_KEY','COMPATIBLE_API_KEY'].filter(key => [providerKey(provider),providerKey(fallback)].includes(key)) as key}
          <label>{key.replaceAll('_',' ')} <span class="optional">{data.secrets[key as keyof typeof data.secrets] ? 'saved' : 'not set'}</span><input type="password" name={key} autocomplete="new-password" placeholder="Leave blank to keep the saved key" /></label>
          {#if data.secrets[key as keyof typeof data.secrets]}<label class="check-label"><input type="checkbox" name={'clear_'+key} /> Remove saved {key.replaceAll('_',' ').toLowerCase()}</label>{/if}
        {/each}
      </div>
    </section>
    <section class="setup-section" id="accounts">
      <div class="section-intro"><span class="step-number">03</span><h2>Your accounts</h2><p>All integrations are optional. Start with manual prospects or the demo, then connect what you need.</p></div>
      <div class="field-stack">
        <h3>Find prospects from LinkedIn engagement</h3>
        <label class="check-label"><input type="checkbox" name="discoveryEnabled" checked={data.settings.integrations.discoveryEnabled} /> Collect through my Unipile account</label>
        <div class="field-grid"><label>Unipile DSN<input name="unipileDsn" value={data.settings.integrations.unipileDsn} placeholder="api123.unipile.com:4567" /></label><label>Unipile account ID<input name="unipileAccountId" value={data.settings.integrations.unipileAccountId} /></label></div>
        <h3>Send approved drafts through HeyReach</h3>
        <div class="field-grid"><label>Campaign ID<input name="heyreachCampaignId" value={data.settings.integrations.heyreachCampaignId} inputmode="numeric" /></label><label>LinkedIn account ID<input name="heyreachAccountId" value={data.settings.integrations.heyreachAccountId} inputmode="numeric" /></label></div>
        <small>This is the LinkedIn sender account ID in HeyReach, not your HeyReach login email. The verified name appears in Review.</small>
        <label class="check-label"><input type="checkbox" name="resumeFinishedCampaign" checked={data.settings.integrations.resumeFinishedCampaign} /> Let new leads resume a finished campaign</label>
        <details><summary>Optional research</summary><div class="field-stack"><label class="check-label"><input type="checkbox" name="verificationEnabled" checked={data.settings.integrations.verificationEnabled} /> Verify company details through Serper</label><label class="check-label"><input type="checkbox" name="enrichmentEnabled" checked={data.settings.integrations.enrichmentEnabled} /> Enrich profiles through Apollo</label><small>These services use your credits. Discovery, verification, and enrichment have daily caps in config/index.ts.</small></div></details>
        {#each ['UNIPILE_API_KEY','HEYREACH_API_KEY','SERPER_API_KEY','APOLLO_API_KEY'] as key}
          <label>{key.replaceAll('_',' ')} <span class="optional">{data.secrets[key as keyof typeof data.secrets] ? 'saved' : 'not set'}</span><input type="password" name={key} autocomplete="new-password" placeholder="Leave blank to keep the saved key" /></label>
          {#if data.secrets[key as keyof typeof data.secrets]}<label class="check-label"><input type="checkbox" name={'clear_'+key} /> Remove saved {key.replaceAll('_',' ').toLowerCase()}</label>{/if}
        {/each}
      </div>
    </section>
    <div class="save-bar"><span>Settings and keys stay in this installation.</span><button class="primary" disabled={pending}>{pending ? 'Working…' : 'Save settings'}</button></div>
  </form>
  <section class="setup-section"><div class="section-intro"><h2>Check your setup</h2><p>Save your changes first. Tests do not contact prospects.</p></div><div class="inline-actions"><form method="POST" action="?/testAi" use:enhance={finish}><button disabled={pending}>Test AI</button></form><form method="POST" action="?/testConnections" use:enhance={finish}><button disabled={pending}>Check connected accounts</button></form></div></section>
  <section class="setup-section" id="sending"><div class="section-intro"><h2>Sending</h2><p>{data.settings.integrations.sendingEnabled && data.kill.sending_enabled ? 'New handoffs are enabled.' : 'New handoffs are paused.'}</p></div><div class="field-stack"><p>HeyReach runs the campaign sequence and schedule. Set its message step to <code>{'{message}'}</code> and its connection note to <code>{'{note}'}</code>. Remove extra follow-ups unless you intend to send them. Review delivery and replies in HeyReach.</p><form method="POST" action="?/enable" use:enhance={finish}><label class="check-label"><input type="checkbox" name="confirmed" required /> I checked the selected sender, campaign sequence, message fields, and schedule in HeyReach.</label><button class="primary" disabled={pending || !data.ready}>Enable approved handoffs</button></form><form method="POST" action="?/pause" use:enhance={finish}><button disabled={pending}>Pause new handoffs</button></form><small>Pausing here cannot recall leads already accepted by HeyReach. Pause that campaign there as well. Demo drafts can never be handed off.</small></div></section>
</div>
