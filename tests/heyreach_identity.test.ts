import { describe, expect, it, vi } from 'vitest';
import { HeyReachClient } from '../src/clients/heyreach.js';
const response = (body: unknown) => new Response(JSON.stringify(body));
describe('the actual LinkedIn sender', () => {
    it('reads the selected account in dry-run mode without enrolling a lead', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ id: 42, firstName: 'Sample', lastName: 'Owner',
            profileUrl: 'https://www.linkedin.com/in/sample-owner', isActive: false,
            authIsValid: false, emailAddress: 'private@example.com' }))
            .mockResolvedValueOnce(response({ accountId: 42, status: 'Disconnected' }));
        const result = await new HeyReachClient('key', 'dry_run', { fetchImpl }).senderIdentity('42');
        expect(result).toMatchObject({ accountId: '42', name: 'Sample Owner', connected: false, detail: 'Reconnect in HeyReach' });
        expect(result).not.toHaveProperty('emailAddress');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0]?.[0]).toContain('/li_account/GetById?accountId=42');
        expect(fetchImpl.mock.calls[1]?.[0]).toContain('/li_account/GetAccountStatus/42');
        expect(fetchImpl.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    });
    it('shows a connected sender even when the campaign activity flag is false', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ id: 42, isActive: false, authIsValid: true }))
            .mockResolvedValueOnce(response({ accountId: 42, status: 'Connected' }));
        expect(await new HeyReachClient('key', 'live', { fetchImpl }).senderIdentity('42'))
            .toMatchObject({ connected: true, restricted: false, detail: 'Connected' });
    });
    it.each(['Disconnected', 'Connecting', 'AwaitingPin', 'Unknown'])('does not treat %s as connected despite active flags', async (status) => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ id: 42, isActive: true, authIsValid: true }))
            .mockResolvedValueOnce(response({ accountId: 42, status }));
        expect(await new HeyReachClient('key', 'live', { fetchImpl }).senderIdentity('42'))
            .toMatchObject({ connected: false });
    });
    it('surfaces a restriction reported by the connection endpoint', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ id: 42 }))
            .mockResolvedValueOnce(response({ accountId: 42, status: 'Disconnected', failureReason: 'LinkedIn account restricted' }));
        expect(await new HeyReachClient('key', 'live', { fetchImpl }).senderIdentity('42'))
            .toMatchObject({ connected: false, restricted: true, detail: 'LinkedIn account restricted' });
    });
    it('refuses a different identity or connection-status account', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ id: 99 }))
            .mockResolvedValueOnce(response({ id: 42 }))
            .mockResolvedValueOnce(response({ accountId: 99, status: 'Connected' }));
        const client = new HeyReachClient('key', 'live', { fetchImpl });
        await expect(client.senderIdentity('42')).rejects.toThrow('different account');
        await expect(client.senderIdentity('42')).rejects.toThrow('different account');
    });
    it('strips non-LinkedIn profile links', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ id: 42, profileUrl: 'https://attacker.test' }))
            .mockResolvedValueOnce(response({ accountId: 42, status: 'Connected' }));
        expect(await new HeyReachClient('key', 'live', { fetchImpl }).senderIdentity('42'))
            .toMatchObject({ connected: true, profileUrl: null });
    });
    it('fails closed when the connection endpoint cannot verify the sender', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ id: 42, isActive: true, authIsValid: true }))
            .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
        await expect(new HeyReachClient('key', 'live', { fetchImpl }).senderIdentity('42'))
            .rejects.toThrow('connection lookup failed: 503');
    });
    it('does not make a request when sender credentials or identity are absent', async () => {
        const fetchImpl = vi.fn();
        expect(await new HeyReachClient('', 'live', { fetchImpl }).senderIdentity('42')).toMatchObject({ connected: false });
        expect(await new HeyReachClient('key', 'live', { fetchImpl }).senderIdentity('')).toMatchObject({ connected: false });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
