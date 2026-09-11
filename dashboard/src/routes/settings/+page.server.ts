import { fail, type Actions } from '@sveltejs/kit';
import { z } from 'zod';
import { SettingsSchema, readSettings, saveSettings, saveSecrets, secretNames, secretStatus, profileReady, type SecretName } from '$local';
import { liveAiRunner } from '$core/clients/ai.js';
import { callStructured } from '$core/clients/claude.js';
import { HeyReachClient } from '$core/clients/heyreach.js';
import { UnipileClient } from '$core/clients/unipile.js';
import { getLaneState, setLaneState } from '$core/repo/index.js';
import { db } from '$db';

export const load = async () => ({ settings: readSettings(), secrets: secretStatus(), ready: profileReady(), kill: await getLaneState<{sending_enabled?: boolean}>('kill_switch', {}) });
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const lines = (form: FormData, key: string) => text(form, key).split('\n').map(x => x.trim()).filter(Boolean);
export const actions: Actions = {
  save: async ({ request, locals }) => {
    const form = await request.formData();
    const previous = readSettings();
    const business = Object.fromEntries(['name','senderName','website','description','offer','audience','writingStyle','proof'].map(k => [k,text(form,k)]));
    const ai = Object.fromEntries(['provider','model','fallback','fallbackModel','compatibleBaseUrl'].map(k => [k,text(form,k)]));
    const integrations = { ...previous.integrations,
      discoveryEnabled: form.has('discoveryEnabled'), verificationEnabled: form.has('verificationEnabled'), enrichmentEnabled: form.has('enrichmentEnabled'),
      unipileDsn: text(form,'unipileDsn'), unipileAccountId: text(form,'unipileAccountId'),
      heyreachCampaignId: text(form,'heyreachCampaignId'), heyreachAccountId: text(form,'heyreachAccountId'),
      resumeFinishedCampaign: form.has('resumeFinishedCampaign'),
    };
    const changedIdentity = integrations.heyreachCampaignId !== previous.integrations.heyreachCampaignId || integrations.heyreachAccountId !== previous.integrations.heyreachAccountId || !!text(form,'HEYREACH_API_KEY') || form.has('clear_HEYREACH_API_KEY');
    const nextBusiness = { ...business, excludedCompanies: lines(form,'excludedCompanies'), bannedPhrases: lines(form,'bannedPhrases') };
    let changedBusiness = false;

    try {
      for (const id of [integrations.heyreachCampaignId, integrations.heyreachAccountId]) if (id && !/^\d+$/.test(id)) throw new Error('HeyReach IDs must be numbers.');
      if (integrations.unipileDsn) {
        const url = new URL(integrations.unipileDsn.startsWith('https://') ? integrations.unipileDsn : `https://${integrations.unipileDsn}`);
        if (url.protocol !== 'https:' || !/^api[0-9]*\.unipile\.com$/.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Enter the HTTPS DSN from Unipile, such as api123.unipile.com:4567.');
      }
      const patch: Partial<Record<SecretName,string>> = {};
      for (const name of secretNames) { if (form.has(`clear_${name}`)) patch[name]=''; else if (text(form,name)) patch[name]=text(form,name); }
      // Validate before any mutation; secrets never enter action responses.
      const parsed = SettingsSchema.parse({ business: nextBusiness, ai, integrations });
      changedBusiness = JSON.stringify(parsed.business) !== JSON.stringify(previous.business);
      if (changedIdentity || changedBusiness) { parsed.integrations.sendingEnabled=false; parsed.integrations.campaignConfirmed=false; }
      for (const [provider,model] of [[parsed.ai.provider,parsed.ai.model],[parsed.ai.fallback,parsed.ai.fallbackModel]]) if (['openai','anthropic','compatible'].includes(provider) && !model) throw new Error('Enter a model ID for each API provider.');
      if (parsed.ai.provider === 'compatible' || parsed.ai.fallback === 'compatible') { const { apiEndpoint } = await import('$core/clients/api_runner.js'); apiEndpoint('compatible',parsed.ai.compatibleBaseUrl); }
      if (changedIdentity || changedBusiness) {
        await setLaneState('kill_switch', {sending_enabled:false},locals.user!);
        await db().query("UPDATE touch SET status='draft', content_hash=NULL, approved_at=NULL, approved_by=NULL WHERE status='approved'");
      }
      saveSecrets(patch); saveSettings(parsed);
      return { message: `Settings saved.${changedIdentity || changedBusiness ? ' Sending is paused; pending approvals need review for this configuration.' : ''}` };
    } catch (error) { return fail(400,{message: error instanceof z.ZodError ? error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ') : (error as Error).message}); }
  },
  testAi: async () => {
    if (readSettings().ai.provider === 'demo') return {message:'Demo mode is ready. Load the sample drafts in Sources. No AI account is contacted.'};
    try { const runner=liveAiRunner(); await callStructured(runner,z.object({ok:z.literal(true)}),'Return exactly this JSON object: {"ok":true}. This is a synthetic connection test.','You return JSON. Use no tools.',0); return {message:`AI connected: ${runner.lastGeneration?.provider}, ${runner.lastGeneration?.model}.`}; }
    catch(error) { return fail(400,{message:`AI test failed: ${(error as Error).message}`}); }
  },
  testConnections: async () => {
    const results: string[]=[];
    try { const sender=await new HeyReachClient().senderIdentity(); results.push(`HeyReach: ${sender.name || 'no sender'} — ${sender.detail}.`); } catch {results.push('HeyReach could not verify the sender. Check your key and account ID.');}
    if (readSettings().integrations.discoveryEnabled) {
      try { const accounts=await new UnipileClient().listAccounts(); const account=accounts.find(a=>a.id===readSettings().integrations.unipileAccountId); results.push(account ? `Unipile account found: ${account.name || account.id}.` : 'Unipile accounts: ' + accounts.slice(0,10).map(a=>`${a.name || a.type} (ID ${a.id})`).join(', ') + '. Copy the intended ID into Settings.'); } catch {results.push('Unipile could not connect. Check your DSN, key, and account ID.');}
    }
    return {message:results.join(' ')};
  },
  enable: async ({request,locals}) => {
    const form=await request.formData();
    const settings=readSettings();
    if (!form.has('confirmed') || !profileReady(settings) || !settings.integrations.heyreachCampaignId) return fail(400,{message:'Complete your business and HeyReach settings, then confirm the campaign setup below.'});
    try {
      const sender=await new HeyReachClient().senderIdentity();
      if (!sender.connected || sender.restricted) return fail(400,{message:`Cannot enable sending: ${sender.detail}.`});
      await setLaneState('kill_switch',{sending_enabled:false},locals.user!);
      saveSettings({...settings,integrations:{...settings.integrations,sendingEnabled:true,campaignConfirmed:true}});
      await setLaneState('kill_switch',{sending_enabled:true,enabled_at:new Date().toISOString()},locals.user!);
      return {message:`Approved real drafts can now be handed to HeyReach using ${sender.name || sender.accountId}. Demo drafts remain blocked.`};
    } catch {return fail(400,{message:'Could not verify the sender. Check HeyReach before enabling sending.'});}
  },
  pause: async ({locals}) => { await setLaneState('kill_switch',{sending_enabled:false},locals.user!); const s=readSettings();saveSettings({...s,integrations:{...s.integrations,sendingEnabled:false}});return {message:'New handoffs paused. To stop leads already queued in HeyReach, pause the campaign there too.'}; },
};
