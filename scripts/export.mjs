import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFiles=new Set(['README.md','SECURITY.md','ARCHITECTURE.md','CHANGELOG.md','VERSION','EXPORT_PROVENANCE.json','.gitignore','.dockerignore','.env.example','.gitleaks.toml','package.json','package-lock.json','tsconfig.json','vitest.config.ts','compose.yaml']);
export function distributable(path) {
  if (rootFiles.has(path)) return true;
  if (/(^|\/)(\.git|\.local|\.context|node_modules|build|dist|\.svelte-kit|out)(\/|$)/.test(path) || /(^|\/)\.env/.test(path) || /\.(log|dump|sql\.gz|zip|pem|key|sqlite|db)$/i.test(path)) return false;
  if (/^dashboard\/(package(-lock)?\.json|svelte\.config\.js|vite(st)?\.config\.ts|tsconfig\.json)$/.test(path))return true;
  if(path==='.github/workflows/ci.yml')return true;
  if(!/^(src|config|db|tests|skills|scripts|examples|fixtures\/unipile|dashboard\/(src|static|tests))\//.test(path))return false;
  return /\.(ts|mjs|js|svelte|css|html|json|sql|md|svg|csv)$/.test(path);
}
export function secretFinding(text) {
  const rules=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/,/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{25,}\b/,/\bAKIA[0-9A-Z]{16}\b/,/postgres(?:ql)?:\/\/[^\s:@]+:(?!setup-required@)[^\s@'"`$]+@/i];
  return rules.some(rule=>rule.test(text));
}
export function inspectCommitted(root) {
  const git=(args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:12_000_000});
  if(resolve(git(['rev-parse','--show-toplevel']).trim())!==resolve(root))throw new Error('Initialize a separate Git repository in the starter directory first.');
  const rows=git(['ls-tree','-r','-z','HEAD']).split('\0').filter(Boolean);
  const findings=[];
  for(const row of rows){const [meta,path]=row.split('\t');
    if(!distributable(path) || !meta.startsWith('100644 blob ') && !meta.startsWith('100755 blob ')){findings.push(`${path}: not in the distribution allowlist`);continue;}
    const content=git(['show',`HEAD:${path}`]);
    if(Buffer.byteLength(content)>1_000_000)findings.push(`${path}: unexpectedly large source file`);
    if(secretFinding(content))findings.push(`${path}: possible credential; inspect locally before exporting`);
  }
  if(findings.length)throw new Error(findings.join('\n'));
  return rows.length;
}
export function exportArchive(root) {
  const count=inspectCommitted(root);
  const changes=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim();
  if(changes)throw new Error('Commit the reviewed source changes before exporting. Local ignored settings are intentionally excluded.');
  mkdirSync(resolve(root,'.local'),{recursive:true,mode:0o700});
  const output=resolve(root,'.local/growth-engine-starter.zip');
  execFileSync('git',['archive','--format=zip','--prefix=growth-engine-starter/','HEAD','-o',output],{cwd:root});
  return {count,output};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const result=exportArchive(resolve(dirname(fileURLToPath(import.meta.url)),'..'));console.log(`Exported ${result.count} reviewed source files to ${result.output}. No Git history or ignored local files included.`);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
