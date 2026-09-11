import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SettingsSchema, saveSettings, readSettings, saveSecrets, readSecret, secretStatus, localDir } from '../config/local.js';
import { buildDraftPrompt, type DraftCandidate } from '../src/pipeline/draft.js';
import { apiRunner, apiEndpoint } from '../src/clients/api_runner.js';
import { parseProspectCsv, profileUrl } from '../src/standalone/data.js';
import { distributable, secretFinding } from '../scripts/export.mjs';
const profile={name:'Example Repairs',senderName:'Taylor Example',audience:'Independent repair companies',offer:'A sample technician schedule',proof:'',writingStyle:'Plain and brief'};
beforeEach(()=>{saveSettings({business:profile});saveSecrets({OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:''});});
it('starts paused and never embeds a shared identity or API key in public settings',()=>{
  expect(SettingsSchema.parse({}).integrations.sendingEnabled).toBe(false);
  expect(SettingsSchema.parse({}).business.senderName).toBe('');
  saveSecrets({OPENAI_API_KEY:'private-test-canary'});
  expect(readSecret('OPENAI_API_KEY')).toBe('private-test-canary');
  expect(secretStatus().OPENAI_API_KEY).toBe(true);
  expect(JSON.stringify({settings:readSettings(),secrets:secretStatus()})).not.toContain('private-test-canary');
  expect(statSync(join(localDir,'secrets.json')).mode & 0o777).toBe(0o600);
  expect(statSync(localDir).mode & 0o777).toBe(0o700);
});
it('rejects unknown settings and preserves secrets when blank fields are omitted',()=>{
  expect(()=>saveSettings({unexpected:'bad'})).toThrow();saveSecrets({OPENAI_API_KEY:'first'});saveSecrets({ANTHROPIC_API_KEY:'second'});expect(readSecret('OPENAI_API_KEY')).toBe('first');saveSecrets({OPENAI_API_KEY:''});expect(readSecret('OPENAI_API_KEY')).toBe('');
});
it('uses the configured business in drafts without a built-in industry or sender',()=>{
  const candidate={channel:'dm',persona:'P1',companyVerified:false,firstName:'Alex',companyName:null,matchProof:null} as DraftCandidate;
  const prompt=buildDraftPrompt(candidate,'B-intro');expect(prompt).toContain('Example Repairs');expect(prompt).toContain('Taylor Example');expect(prompt).toContain('A sample technician schedule');expect(prompt).not.toContain('program/contact research');
});
it('requires API keys before making a remote call',async()=>{
  const fetchImpl=vi.fn();await expect(apiRunner({provider:'openai',model:'test-model',fetchImpl})('task','JSON')).rejects.toThrow('OPENAI_API_KEY');expect(fetchImpl).not.toHaveBeenCalled();
});
it('keeps OpenAI keys on the fixed OpenAI endpoint and validates completed text responses',async()=>{
  saveSecrets({OPENAI_API_KEY:'test-key'});const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({status:'completed',model:'actual-model',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}]})));
  const run=apiRunner({provider:'openai',model:'test-model',fetchImpl});expect(await run('Return JSON','JSON only')).toBe('{"ok":true}');expect(run.lastGeneration).toEqual({provider:'openai',model:'actual-model'});
  const [url,init]=fetchImpl.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://api.openai.com/v1/responses');expect(JSON.parse(String(init.body))).toMatchObject({store:false,tools:[]});expect(init.redirect).toBe('error');
});
it('supports a local compatible API without borrowing a cloud API key',async()=>{
  saveSecrets({OPENAI_API_KEY:'cloud-key'});let headers:unknown;
  const run=apiRunner({provider:'compatible',model:'local-model',compatibleBaseUrl:'http://127.0.0.1:11434/v1',fetchImpl:async(_url,init)=>{headers=init?.headers;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));}});
  expect(await run('task','rules')).toBe('{"ok":true}');expect(headers).not.toHaveProperty('Authorization');
  expect(()=>apiEndpoint('compatible','http://remote.example/v1')).toThrow('HTTPS');expect(()=>apiEndpoint('compatible','https://user:password@remote.example/v1')).toThrow('credentials');
});
it('supports Anthropic with its own key and rejects non-text output',async()=>{
  saveSecrets({ANTHROPIC_API_KEY:'test-key'});let sent:any;
  const run=apiRunner({provider:'anthropic',model:'test-model',fetchImpl:async(_url,init)=>{sent=init;return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'tool_use'}]}));}});
  await expect(run('task','rules')).rejects.toMatchObject({kind:'malformed'});expect(sent.headers['x-api-key']).toBe('test-key');expect(sent.headers.Authorization).toBeUndefined();
});
it('never exposes a provider error body containing keys or prompt data',async()=>{
  saveSecrets({OPENAI_API_KEY:'test-key'});const run=apiRunner({provider:'openai',model:'test',fetchImpl:async()=>new Response('secret-canary',{status:429})});await expect(run('task','rules')).rejects.toMatchObject({kind:'rate_limit'});try{await run('task','rules');}catch(error){expect((error as Error).message).not.toContain('secret-canary');}
});
it('imports real-shaped prospect records without fabricating an engagement',()=>{
  const rows=parseProspectCsv('linkedin_url,full_name,headline,company,context\nhttps://linkedin.com/in/integration-person?trk=x,Alex Example,"Repair lead, dispatcher",,"Specific context about scheduling technician visits."');
  expect(rows[0]?.linkedin_url).toBe('https://www.linkedin.com/in/integration-person');expect(rows[0]?.headline).toBe('Repair lead, dispatcher');expect(()=>profileUrl('https://example.invalid/person')).toThrow();expect(()=>profileUrl('https://linkedin.com/in/sample-person')).toThrow();expect(()=>parseProspectCsv('wrong,headers\na,b')).toThrow();
});
it('keeps private data, history, auth, deployment files and build artifacts out of distributions',()=>{
  for(const path of ['.env','.env.production','.local/secrets.json','.context/transcript.md','.git/config','dashboard/build/index.js','fixtures/captured/accounts.json','credentials.pem','report/out/replies.md','.github/workflows/deploy.yml'])expect(distributable(path),path).toBe(false);
  expect(distributable('src/clients/ai.ts')).toBe(true);expect(distributable('.env.example')).toBe(true);expect(secretFinding('sk-'+'a'.repeat(30))).toBe(true);expect(secretFinding('postgres://'+'owner:'+ 'private-pass@host/db')).toBe(true);
});
