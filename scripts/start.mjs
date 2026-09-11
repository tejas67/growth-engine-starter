import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (!existsSync('.env')) { console.error('Run npm run setup first.'); process.exit(1); }
dotenv.config({ path: resolve(root, '.env') });
process.env.GROWTH_ROOT = root;
process.env.HOST = '127.0.0.1';
process.env.PORT = process.env.GROWTH_APP_PORT || '3100';
process.env.ORIGIN = `http://localhost:${process.env.PORT}`;
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) { console.error(`${command} failed. ${result.error?.message || 'Check the output above.'}`); process.exit(1); }
};
if (!process.argv.includes('--external-db')) run('docker', ['compose', 'up', '-d', '--wait', 'db']);
run('npm', ['run', 'migrate']);
run('npm', ['run', 'dashboard:build']);
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'src/queue/worker.ts'], { cwd: root, env: process.env, stdio: 'inherit' }),
  spawn(process.execPath, ['dashboard/build/index.js'], { cwd: root, env: process.env, stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 8000);
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
    .then(() => { clearTimeout(timer); process.exit(code); });
}
for (const child of children) {
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => { if (!stopping) stop(code || 1); });
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
console.log(`\nGrowth Engine: ${process.env.ORIGIN}\nCtrl+C stops the app and worker. Your database remains available.\n`);
