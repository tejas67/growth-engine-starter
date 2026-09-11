import {beforeAll,afterAll,it,expect} from 'vitest';
import {db,closeDb} from '../db/client.js';
import {up} from '../db/migrate.js';
import {config} from '../config/index.js';
import {saveSettings,readSettings} from '../config/local.js';
import {importProspects,loadDemo} from '../src/standalone/data.js';
import {runScore,runDraft,runSend} from '../src/pipeline/stages.js';
import {listApprovedTouches,setLaneState} from '../src/repo/index.js';
import {contentHash} from '../src/lib/hash.js';
import type {ClaudeRunner} from '../src/clients/claude.js';
import type {HeyReachClient} from '../src/clients/heyreach.js';
import {recordOutcome} from '../src/standalone/outcomes.js';
import {describe} from 'vitest';
describe.skipIf(process.env.GROWTH_INTEGRATION_TESTS!=='1')('standalone database workflow',()=>{
  beforeAll(async()=>{if(!new URL(config.database.url).pathname.startsWith('/growth_test_'))throw new Error('Dedicated test database required');await up();});
  afterAll(closeDb);
  it('keeps synthetic prospects out of the dispatch queue, including after approval',async()=>{
    expect(await loadDemo()).toBe(3);expect(await loadDemo()).toBe(0);
    await db().query("UPDATE touch SET status='approved' WHERE generation_provider='demo'");
    expect(await listApprovedTouches()).toHaveLength(0);
    await expect(db().query("UPDATE prospect SET is_demo=FALSE WHERE is_demo")).rejects.toThrow('cannot become live');
    await expect(db().query("UPDATE touch SET status='queued' WHERE generation_provider='demo'")).rejects.toThrow('cannot be sent');
  });
  it('processes a manual prospect without making up likes, comments, or source posts',async()=>{
    saveSettings({business:{name:'Fictional Schedules',senderName:'Taylor Example',offer:'A sample technician schedule',audience:'Repair operations managers'},ai:{provider:'codex'}});
    await importProspects([{linkedin_url:'https://www.linkedin.com/in/integration-person',full_name:'Alex Example',headline:'Operations manager for a repair team',company:'Fictional Repairs',context:'Coordinates technician visits with spreadsheets and wants a clearer weekly schedule.'}]);
    const score:ClaudeRunner=async()=>JSON.stringify({assessments:[{linkedin_url:'https://www.linkedin.com/in/integration-person',score:85,persona:'P1',verification_required:false,gov_signal:false,hold:false,reasoning:'Repair operations matches the configured audience.'}]});score.lastGeneration={provider:'test',model:'test-score'};
    expect(await runScore(score)).toMatchObject({scored:1,held:0});
    const draft:ClaudeRunner=async()=>JSON.stringify({subject:null,body:'Alex, repair visits can be hard to schedule around changing availability. We help dispatchers plan the week. I can show you a sample technician schedule. Would that be useful?',connect_note:'Alex, we help dispatchers organize technician schedules. I can show you a sample weekly plan. Open to connecting?',shape:'B-intro',angle:'A3',rationale:'The supplied scheduling context fits our offer.'});draft.lastGeneration={provider:'test',model:'test-draft'};
    expect(await runDraft(draft)).toEqual({drafted:1,rejected:0});
    const {rows:[touch]}=await db().query("SELECT t.* FROM touch t JOIN prospect p ON p.id=t.prospect_id WHERE NOT p.is_demo");
    expect(touch.signal_type).toBe('none');expect(touch.generation_model).toBe('test-draft');
    expect((await db().query('SELECT COUNT(*)::int AS n FROM engagement')).rows[0].n).toBe(0);
    await db().query("UPDATE touch SET status='approved',approved_at=NOW(),content_hash=$2 WHERE id=$1",[touch.id,contentHash(touch.subject,touch.body,touch.connect_note)]);
  });
  it('does not retry an ambiguous provider result or count it as a delivered message',async()=>{
    const s=readSettings();saveSettings({...s,integrations:{...s.integrations,sendingEnabled:true,campaignConfirmed:true,heyreachCampaignId:'2001',heyreachAccountId:'1001'}});await setLaneState('kill_switch',{sending_enabled:true},'test');
    let calls=0;const client={senderIdentity:async()=>({connected:true,restricted:false}),send:async()=>{calls++;throw new Error('simulated lost response');}} as unknown as HeyReachClient;
    expect(await runSend(client)).toEqual({dispatched:0,refused:1});
    expect(await runSend(client)).toEqual({dispatched:0,refused:0});expect(calls).toBe(1);
    expect((await db().query('SELECT status FROM dispatch_attempt')).rows[0].status).toBe('uncertain');
    expect((await db().query("SELECT COUNT(*)::int AS n FROM touch WHERE sent_at IS NOT NULL OR enrolled_at IS NOT NULL")).rows[0].n).toBe(0);
  });
  it('records confirmed outcomes idempotently and rejects demo outcomes',async()=>{
    const {rows:[demo]}=await db().query("SELECT id FROM touch WHERE generation_provider='demo' LIMIT 1");
    await expect(recordOutcome(demo.id,'sent','test')).rejects.toThrow('Only a real lead');
    const {rows:[touch]}=await db().query("INSERT INTO touch(prospect_id,channel,template_version,body,status,enrolled_at,dry_run) SELECT id,'dm','test','Synthetic test message','queued',NOW(),FALSE FROM prospect WHERE NOT is_demo LIMIT 1 RETURNING id");
    await db().query("INSERT INTO dispatch_attempt(touch_id,status) VALUES($1,'accepted')",[touch.id]);
    await recordOutcome(touch.id,'positive_reply','test');await recordOutcome(touch.id,'positive_reply','test');
    expect((await db().query('SELECT COUNT(*)::int AS n FROM event WHERE touch_id=$1',[touch.id])).rows[0].n).toBe(3);
    await recordOutcome(touch.id,'negative_reply','test');
    const kinds=(await db().query('SELECT kind FROM event WHERE touch_id=$1',[touch.id])).rows.map(r=>r.kind);
    expect(kinds).toContain('negative_reply');expect(kinds).not.toContain('positive_reply');
  });

});
