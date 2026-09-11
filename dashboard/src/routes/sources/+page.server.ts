import { fail, type Actions } from '@sveltejs/kit';
import { recordOutcome, outcomeKinds, type OutcomeKind } from '$core/standalone/outcomes.js';
import { db } from '$db';
import { readSettings, profileReady } from '$local';
import { upsertSeedAccount } from '$core/repo/index.js';
import { importProspects, parseProspect, parseProspectCsv, loadDemo } from '$core/standalone/data.js';
import { getBoss, QUEUES } from '$core/queue/boss.js';

export const load = async () => {
  const [seeds,prospects,attempts,jobs]=await Promise.all([
    db().query('SELECT id,slug,display_name,linkedin_url,track,last_scraped_at FROM seed_account ORDER BY id DESC LIMIT 100'),
    db().query('SELECT id,full_name,headline,state,hold_reason,is_demo FROM prospect WHERE canonical_prospect_id IS NULL ORDER BY id DESC LIMIT 100'),
    db().query('SELECT d.touch_id,d.status,d.detail,d.attempted_at,p.full_name FROM dispatch_attempt d JOIN touch t ON t.id=d.touch_id JOIN prospect p ON p.id=t.prospect_id ORDER BY d.attempted_at DESC LIMIT 50'),
    db().query("SELECT name,state,createdon,completedon FROM pgboss.job ORDER BY createdon DESC LIMIT 10").catch(()=>({rows:[]})),
  ]);
  return {seeds:seeds.rows,prospects:prospects.rows,attempts:attempts.rows,jobs:jobs.rows,ready:profileReady(),demo:readSettings().ai.provider==='demo'};
};
export const actions:Actions={
  outcome:async({request,locals})=>{const f=await request.formData();const kind=String(f.get('kind'));if(!outcomeKinds.includes(kind as OutcomeKind))return fail(400,{message:'Choose a confirmed outcome.'});try{await recordOutcome(Number(f.get('id')),kind as OutcomeKind,locals.user!);return {message:'Confirmed outcome recorded in Results. Replies pause further outreach in this app; manage any remaining campaign follow-ups in HeyReach.'};}catch(error){return fail(400,{message:(error as Error).message});}},
  addSeed:async({request})=>{
    const form=await request.formData();
    try{
      const raw=String(form.get('url')??'').trim();const url=new URL(raw.startsWith('https://')?raw:`https://${raw}`);
      if(!['www.linkedin.com','linkedin.com'].includes(url.hostname)||url.username||url.password||url.port||!/^\/(in|company|showcase)\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname))throw new Error('Use a LinkedIn person, company, or showcase page URL.');
      const [,kind,slug]=url.pathname.split('/');
      if(/^(sample-|example-|demo-|your-|their-)/.test(slug!))throw new Error('Use the real source account, not an example URL.');
      await upsertSeedAccount({slug:slug!.toLowerCase(),kind:kind==='in'?'person':'company',displayName:String(form.get('name')??'').trim().slice(0,120)||null,linkedinUrl:`https://www.linkedin.com/${kind}/${slug!.toLowerCase()}`,tier:1,track:true,cadenceClass:'unknown',notes:null});
      return {message:'Source added. The next discovery run will check it if Unipile is enabled.'};
    }catch(error){return fail(400,{message:(error as Error).message});}
  },
  toggleSeed:async({request})=>{const form=await request.formData();const id=Number(form.get('id'));if(!Number.isSafeInteger(id))return fail(400,{message:'Invalid source.'});await db().query('UPDATE seed_account SET track=NOT track WHERE id=$1',[id]);return {message:'Source updated.'};},
  addProspect:async({request})=>{const form=await request.formData();try{await importProspects([parseProspect(Object.fromEntries(['linkedin_url','full_name','headline','company','context'].map(k=>[k,String(form.get(k)??'')]))) ]);return {message:'Prospect added. Run the engine to assess fit and draft.'};}catch{return fail(400,{message:'Enter a real LinkedIn person URL, name, headline, and at least 20 characters explaining relevance.'});}},
  importCsv:async({request})=>{const form=await request.formData();const file=form.get('csv');if(!file || typeof file==='string' || file.size>1_000_000)return fail(400,{message:'Choose a CSV file up to 1 MB.'});try{const count=await importProspects(parseProspectCsv(await file.text()));return {message:`Imported ${count} prospects. Run the engine to assess fit and draft.`};}catch(error){return fail(400,{message:(error as Error).message});}},
  demo:async()=>({message:`Added ${await loadDemo()} synthetic drafts. Open Review to try editing and approving. Demo identities can never be sent.`}),
  run:async()=>{
    if(!profileReady()||readSettings().ai.provider==='demo')return fail(400,{message:'Complete your business profile and choose an AI provider in Settings first, or load the demo below.'});
    const boss=await getBoss();await boss.createQueue(QUEUES.refresh);await boss.send(QUEUES.refresh,{}, {singletonKey:'manual-refresh',singletonSeconds:60,retryLimit:0});return {message:'Run queued. The worker will collect enabled sources, assess fit, research, and draft. Refresh this page to see progress.'};
  },
  retryHold:async({request,locals})=>{const form=await request.formData();const id=Number(form.get('id'));if(!Number.isSafeInteger(id))return fail(400,{message:'Invalid prospect.'});await db().query("UPDATE prospect SET state='new',hold_reason=NULL WHERE id=$1 AND state='held' AND NOT is_demo",[id]);await db().query('UPDATE pipeline_hold SET resolved_at=NOW(),resolved_by=$2 WHERE subject_kind=\'prospect\' AND subject_id=$1 AND resolved_at IS NULL',[id,locals.user]);return {message:'Prospect requeued for assessment. Run the engine after fixing the missing context or AI configuration.'};},
};
