import { existsSync, readFileSync, lstatSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
export const projectRoot = process.env.GROWTH_ROOT || process.cwd();
export const localDir = process.env.GROWTH_LOCAL_DIR || join(projectRoot, '.local');
export const providerNames = ['demo', 'codex', 'claude', 'openai', 'anthropic', 'compatible'] as const;
export const SettingsSchema = z.object({
    business: z.object({
        name: z.string().trim().max(120).default(''),
        senderName: z.string().trim().max(120).default(''),
        website: z.string().trim().max(300).default(''),
        description: z.string().trim().max(3000).default(''),
        offer: z.string().trim().max(2000).default(''),
        audience: z.string().trim().max(3000).default(''),
        excludedCompanies: z.array(z.string().trim().min(2).max(120)).max(100).default([]),
        writingStyle: z.string().trim().max(2000).default('Short, specific, plain language. Offer something useful. No invented familiarity, flattery, or unverified claims.'),
        proof: z.string().trim().max(3000).default(''),
        bannedPhrases: z.array(z.string().trim().min(2).max(100)).max(100).default([]),
    }).default({}),
    ai: z.object({
        provider: z.enum(providerNames).default('demo'),
        model: z.string().trim().max(150).default(''),
        fallback: z.enum(['none', 'codex', 'claude', 'openai', 'anthropic', 'compatible']).default('none'),
        fallbackModel: z.string().trim().max(150).default(''),
        compatibleBaseUrl: z.string().trim().max(400).default('http://127.0.0.1:11434/v1'),
    }).default({}),
    integrations: z.object({
        sendingEnabled: z.boolean().default(false),
        campaignConfirmed: z.boolean().default(false),
        resumeFinishedCampaign: z.boolean().default(false),
        discoveryEnabled: z.boolean().default(false),
        unipileDsn: z.string().trim().max(400).default(''),
        unipileAccountId: z.string().trim().max(200).default(''),
        verificationEnabled: z.boolean().default(false),
        enrichmentEnabled: z.boolean().default(false),
        heyreachCampaignId: z.string().trim().max(50).default(''),
        heyreachAccountId: z.string().trim().max(50).default(''),
    }).default({}),
}).strict();
export type LocalSettings = z.infer<typeof SettingsSchema>;
export const secretNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPATIBLE_API_KEY', 'UNIPILE_API_KEY', 'HEYREACH_API_KEY', 'SERPER_API_KEY', 'APOLLO_API_KEY'] as const;
export type SecretName = typeof secretNames[number];
function localFile(name: string): string {
    if (existsSync(localDir) && lstatSync(localDir).isSymbolicLink())
        throw new Error('The local settings directory must not be a symlink');
    const path = join(localDir, name);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error('Settings files must not be symlinks');
    return path;
}
export function readSettings(): LocalSettings {
    const path = localFile('settings.json');
    return SettingsSchema.parse(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
}
function writeLocal(name: string, value: unknown) {
    localFile(name);
    mkdirSync(localDir, { recursive: true, mode: 0o700 });
    chmodSync(localDir, 0o700);
    const path = localFile(name);
    const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
    chmodSync(path, 0o600);
}
export function saveSettings(value: unknown): LocalSettings {
    const settings = SettingsSchema.parse(value);
    writeLocal('settings.json', settings);
    return settings;
}
function storedSecrets(): Partial<Record<SecretName, string>> {
    const path = localFile('secrets.json');
    if (!existsSync(path))
        return {};
    return z.record(z.enum(secretNames), z.string().max(8192)).parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function readSecret(name: SecretName): string {
    return storedSecrets()[name] ?? process.env[name] ?? '';
}
export function saveSecrets(patch: Partial<Record<SecretName, string>>) {
    const parsed = z.record(z.enum(secretNames), z.string().max(8192)).parse(patch);
    writeLocal('secrets.json', { ...storedSecrets(), ...parsed });
}
export function secretStatus(): Record<SecretName, boolean> {
    return Object.fromEntries(secretNames.map(name => [name, !!readSecret(name)])) as Record<SecretName, boolean>;
}
export function profileReady(settings = readSettings()): boolean {
    return !!(settings.business.name && settings.business.senderName && settings.business.offer && settings.business.audience);
}
export function businessContext(settings = readSettings()): string {
    return 'BUSINESS CONFIGURATION (provided by the owner; use only these claims):\n' + JSON.stringify(settings.business, null, 2);
}
