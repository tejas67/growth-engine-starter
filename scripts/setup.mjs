import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (existsSync('.env')) { console.log('Already set up. Run npm start, then configure your business in Settings.'); process.exit(0); }
const [major,minor]=process.versions.node.split('.').map(Number);
if (!((major===22 && minor>=12) || major>=24)) throw new Error('Use Node.js 22.12+ on the 22.x line, or Node.js 24+.');
const nonInteractive = process.argv.includes('--non-interactive');
let user = process.env.GROWTH_SETUP_USER || 'owner';
let password = process.env.GROWTH_SETUP_PASSWORD || '';
if (!nonInteractive) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  user = (await rl.question('Your login name [owner]: ')).trim() || user;
  rl.close();
  // Generate a one-time local password instead of echoing a typed password in terminals.
  if (!password) { password = randomBytes(15).toString('base64url'); console.log(`Your dashboard password: ${password}\nSave it in your password manager. It will not be printed again.`); }
}
if (!/^[a-zA-Z0-9@._-]{1,80}$/.test(user)) throw new Error('Login name must use letters, numbers, @, periods, underscores or hyphens.');
if (password.length < 12 || password.length > 256) throw new Error('Use GROWTH_SETUP_PASSWORD with a password of at least 12 characters for non-interactive setup.');
const salt = randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex')}`;
const databasePassword = randomBytes(24).toString('hex');
const dbPort = process.env.GROWTH_SETUP_DB_PORT || '5447';
const appPort = process.env.GROWTH_SETUP_APP_PORT || '3100';
if (![dbPort, appPort].every(v => /^\d+$/.test(v) && Number(v) >= 1024 && Number(v) <= 65535)) throw new Error('Ports must be between 1024 and 65535.');
mkdirSync('.local', { recursive: true, mode: 0o700 });
chmodSync('.local', 0o700);
const environment = [
  `COMPOSE_PROJECT_NAME=growth-starter-${randomBytes(4).toString('hex')}`,
  `POSTGRES_PASSWORD=${databasePassword}`, `GROWTH_DB_PORT=${dbPort}`, `GROWTH_APP_PORT=${appPort}`,
  `GROWTH_DATABASE_URL=postgres://growth:${databasePassword}@127.0.0.1:${dbPort}/growth_starter`,
  `GROWTH_DASHBOARD_USER=${user}`, `GROWTH_DASHBOARD_PASSWORD_HASH='${hash}'`,
  `GROWTH_SESSION_SECRET=${randomBytes(32).toString('hex')}`,
].join('\n') + '\n';
writeFileSync('.env', environment, { mode: 0o600, flag: 'wx' });
if (!existsSync('dashboard/node_modules')) {
  const install = spawnSync('npm', ['ci', '--prefix', 'dashboard', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  if (install.status !== 0) { console.error('Dashboard installation failed. Run npm ci --prefix dashboard, then npm start.'); process.exit(1); }
}
console.log(`Setup complete. Run npm start and open http://localhost:${appPort}. Sign in as ${user}, then open Settings. Sending starts paused.`);
