import { simpleParser } from 'mailparser';
import { config } from '../../config/index.js';
import { logger } from '../lib/log.js';
const log = logger('imap');
export interface DetectedReply {
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    from: string | null;
    subject: string | null;
    text: string;
    receivedAt: Date;
    gmailThreadId: string | null;
}
export interface ImapReader {
    fetchSince(since: Date): Promise<DetectedReply[]>;
}
export class StaticImapReader implements ImapReader {
    constructor(private readonly messages: DetectedReply[]) { }
    async fetchSince(since: Date): Promise<DetectedReply[]> {
        return this.messages.filter((m) => m.receivedAt >= since);
    }
}
export interface ImapOptions {
    enabled?: boolean;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    mailbox?: string;
}
export interface ImapProbeResult {
    ok: boolean;
    configured: boolean;
    detail: string;
}
export class ImapFlowReader implements ImapReader {
    private readonly enabled: boolean;
    private readonly host: string;
    private readonly port: number;
    private readonly user: string;
    private readonly password: string;
    private readonly mailbox: string;
    constructor(opts: ImapOptions = {}) {
        this.enabled = opts.enabled ?? config.ingest.imapEnabled;
        this.host = opts.host ?? config.ingest.imapHost;
        this.port = opts.port ?? config.ingest.imapPort;
        this.user = opts.user ?? config.ingest.imapUser;
        this.password = opts.password ?? config.ingest.imapPassword;
        this.mailbox = opts.mailbox ?? config.ingest.imapMailbox;
    }
    get degraded(): boolean {
        return this.enabled && (!this.user || !this.password);
    }
    get configured(): boolean {
        return this.enabled && Boolean(this.user) && Boolean(this.password);
    }
    async fetchSince(since: Date): Promise<DetectedReply[]> {
        if (!this.enabled) {
            log.info('IMAP disabled — reply detection degrades to manual founder triage');
            return [];
        }
        if (!this.user || !this.password) {
            log.warn('DEGRADED: IMAP_USER / IMAP_PASSWORD are not set — no mailbox was opened', {
                consequence: 'email replies will not be detected; the founder sees them in Gmail only',
            });
            return [];
        }
        const { ImapFlow } = await import('imapflow');
        const client = new ImapFlow({
            host: this.host,
            port: this.port,
            secure: true,
            auth: { user: this.user, pass: this.password },
            logger: false,
        });
        const out: DetectedReply[] = [];
        await client.connect();
        try {
            const lock = await client.getMailboxLock(this.mailbox, { readOnly: true });
            try {
                for await (const message of client.fetch({ since }, { source: true, envelope: true, headers: true })) {
                    if (!message.source)
                        continue;
                    const parsed = await simpleParser(message.source);
                    const references = Array.isArray(parsed.references)
                        ? parsed.references
                        : parsed.references
                            ? [parsed.references]
                            : [];
                    out.push({
                        messageId: parsed.messageId ?? null,
                        inReplyTo: parsed.inReplyTo ?? null,
                        references,
                        from: parsed.from?.value?.[0]?.address ?? null,
                        subject: parsed.subject ?? null,
                        text: parsed.text ?? '',
                        receivedAt: parsed.date ?? new Date(),
                        gmailThreadId: null,
                    });
                }
            }
            finally {
                lock.release();
            }
        }
        finally {
            await client.logout().catch(() => undefined);
        }
        return out;
    }
    async probe(): Promise<ImapProbeResult> {
        if (!this.enabled) {
            return { ok: true, configured: false, detail: 'GROWTH_IMAP_ENABLED is false' };
        }
        if (!this.user || !this.password) {
            return { ok: false, configured: false, detail: 'IMAP_USER / IMAP_PASSWORD absent' };
        }
        const { ImapFlow } = await import('imapflow');
        const client = new ImapFlow({
            host: this.host,
            port: this.port,
            secure: true,
            auth: { user: this.user, pass: this.password },
            logger: false,
        });
        await client.connect();
        await client.logout().catch(() => undefined);
        return { ok: true, configured: true, detail: `connected to ${this.host}:${this.port}` };
    }
}
