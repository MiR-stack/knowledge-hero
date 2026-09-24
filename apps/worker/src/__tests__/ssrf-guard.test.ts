import { describe, it, expect, vi, afterEach } from 'vitest';
import { isBlockedIp, checkHostForSSRF, SSRFBlockedError } from '../parsers/web-url.js';
import dns from 'node:dns/promises';

vi.mock('node:dns/promises');

const mockedDns = dns as unknown as { lookup: ReturnType<typeof vi.fn> };

afterEach(() => vi.clearAllMocks());

describe('isBlockedIp', () => {
  it('blocks RFC 1918 10/8', () => expect(isBlockedIp('10.0.0.1')).toBe(true));
  it('blocks RFC 1918 172.16-31', () => expect(isBlockedIp('172.16.0.1')).toBe(true));
  it('blocks RFC 1918 172.31', () => expect(isBlockedIp('172.31.255.255')).toBe(true));
  it('blocks RFC 1918 192.168', () => expect(isBlockedIp('192.168.1.1')).toBe(true));
  it('blocks link-local 169.254.x.x', () => expect(isBlockedIp('169.254.169.254')).toBe(true));
  it('blocks loopback 127.0.0.1', () => expect(isBlockedIp('127.0.0.1')).toBe(true));
  it('blocks loopback 127.x.x.x', () => expect(isBlockedIp('127.0.0.42')).toBe(true));
  it('blocks IPv6 loopback ::1', () => expect(isBlockedIp('::1')).toBe(true));
  it('blocks IPv6 link-local fe80:', () => expect(isBlockedIp('fe80::1')).toBe(true));
  it('allows public IP 8.8.8.8', () => expect(isBlockedIp('8.8.8.8')).toBe(false));
  it('allows public IP 1.1.1.1', () => expect(isBlockedIp('1.1.1.1')).toBe(false));
  it('does not block 172.15.x.x (just outside range)', () => expect(isBlockedIp('172.15.0.1')).toBe(false));
  it('does not block 172.32.x.x (just outside range)', () => expect(isBlockedIp('172.32.0.1')).toBe(false));
});

describe('checkHostForSSRF', () => {
  it('throws SSRFBlockedError for hostname resolving to 169.254.169.254', async () => {
    (mockedDns as any).lookup = vi.fn().mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(checkHostForSSRF('metadata.internal')).rejects.toThrow(SSRFBlockedError);
  });

  it('throws SSRFBlockedError for hostname resolving to private IP', async () => {
    (mockedDns as any).lookup = vi.fn().mockResolvedValue([{ address: '192.168.1.1', family: 4 }]);
    await expect(checkHostForSSRF('internal.corp')).rejects.toThrow(SSRFBlockedError);
  });

  it('throws SSRFBlockedError for redirect to private IP (same check applies)', async () => {
    // Simulates a redirect hop: the route handler calls checkHostForSSRF again with the redirect target
    (mockedDns as any).lookup = vi.fn().mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(checkHostForSSRF('evil-redirect.example.com')).rejects.toThrow(SSRFBlockedError);
  });

  it('throws SSRFBlockedError for IP literal 127.0.0.1', async () => {
    await expect(checkHostForSSRF('127.0.0.1')).rejects.toThrow(SSRFBlockedError);
  });

  it('does not throw for hostname resolving to public IP', async () => {
    (mockedDns as any).lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    await expect(checkHostForSSRF('dns.google')).resolves.toBeUndefined();
  });
});
