import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
const dir=mkdtempSync(join(tmpdir(),'growth-unit-'));
process.env.GROWTH_LOCAL_DIR=dir;
for(const name of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','COMPATIBLE_API_KEY','UNIPILE_API_KEY','HEYREACH_API_KEY','SERPER_API_KEY','APOLLO_API_KEY']) delete process.env[name];
afterAll(()=>rmSync(dir,{recursive:true,force:true}));
