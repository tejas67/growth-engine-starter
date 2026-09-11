import {beforeEach,expect,it,vi} from 'vitest';
import {saveSettings} from '../config/local.js';
import {ClaudeError,type ClaudeRunner} from '../src/clients/claude.js';
import {apiRunner} from '../src/clients/api_runner.js';
import {codexRunner} from '../src/clients/codex.js';
import {liveAiRunner} from '../src/clients/ai.js';
vi.mock('../src/clients/api_runner.js',()=>({apiRunner:vi.fn()}));
vi.mock('../src/clients/codex.js',()=>({codexRunner:vi.fn()}));
let n=0;
beforeEach(()=>{vi.clearAllMocks();saveSettings({business:{name:'Example business',senderName:'Example owner',offer:'A useful sample',audience:'Example audience'},ai:{provider:'openai',model:'test-'+n++,fallback:'codex',fallbackModel:'test-fallback'}});});
it('falls back on a usage limit, preserves provenance, and skips the primary during cooldown',async()=>{
  const primary=vi.fn(async()=>{throw new ClaudeError('rate limited','rate_limit');});
  const backup:ClaudeRunner=vi.fn(async()=>'{"ok":true}');backup.lastGeneration={provider:'codex',model:'test-fallback'};
  vi.mocked(apiRunner).mockReturnValue(primary);vi.mocked(codexRunner).mockReturnValue(backup);
  const run=liveAiRunner();expect(await run('task','rules')).toBe('{"ok":true}');expect(run.lastGeneration).toEqual(backup.lastGeneration);await run('task','rules');expect(primary).toHaveBeenCalledTimes(1);expect(backup).toHaveBeenCalledTimes(2);
});
it.each(['malformed','refusal','transport','timeout'] as const)('does not bypass a %s failure through fallback',async kind=>{
  vi.mocked(apiRunner).mockReturnValue(async()=>{throw new ClaudeError('held',kind);});
  await expect(liveAiRunner()('task','rules')).rejects.toMatchObject({kind});expect(codexRunner).not.toHaveBeenCalled();
});
