import { webcrypto } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  base64UrlFromBytes,
  createCodeVerifier,
  expiresAtFrom,
  isExpired,
  pkceChallengeFrom,
  regionKeyFor,
  resolveRegion,
  tenantFromPath,
} from './lib.js';
import type { RegionStore } from './types.js';

const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const SERVED_LIB_SPECIFIER = new URL('./public/lib.js', import.meta.url).href;

function storeFrom(entries: Map<string, string>): RegionStore {
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

describe('tenantFromPath', () => {
  it.each([
    ['/', undefined],
    ['/tenant-a', 'tenant-a'],
    ['/tenant-a/', 'tenant-a'],
    ['/tenant-a/oauth2/callback', 'tenant-a'],
    ['/tenant-b', 'tenant-b'],
    ['/Tenant-A', undefined],
    ['/tenant_a', undefined],
    ['/-leading-hyphen', undefined],
  ])('maps %s to %s', (pathname, expected) => {
    expect(tenantFromPath(pathname)).toBe(expected);
  });
});

describe('PKCE helpers', () => {
  it('derives the RFC 7636 S256 challenge with node webcrypto', async () => {
    await expect(pkceChallengeFrom(RFC7636_VERIFIER, webcrypto.subtle)).resolves.toBe(
      RFC7636_CHALLENGE,
    );
  });

  it('encodes bytes exactly like base64url', () => {
    const bytes = Uint8Array.from([0, 1, 250, 251, 252, 253, 254, 255, 62, 63]);

    expect(base64UrlFromBytes(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });

  it('builds verifiers from random bytes without padding or reserved characters', () => {
    const verifier = createCodeVerifier(Uint8Array.from({ length: 32 }, (_, index) => index * 8));

    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe('resolveRegion', () => {
  it('fetches once, caches, then answers from the cache', async () => {
    const entries = new Map<string, string>();
    const fetchRegion = vi.fn().mockResolvedValue('eu');
    const store = storeFrom(entries);

    await expect(resolveRegion(store, 'tenant-a', fetchRegion)).resolves.toBe('eu');
    await expect(resolveRegion(store, 'tenant-a', fetchRegion)).resolves.toBe('eu');

    expect(fetchRegion).toHaveBeenCalledTimes(1);
    expect(entries.get(regionKeyFor('tenant-a'))).toBe('eu');
  });

  it('answers a pre-populated cache without fetching', async () => {
    const entries = new Map([[regionKeyFor('tenant-b'), 'us']]);
    const fetchRegion = vi.fn();

    await expect(resolveRegion(storeFrom(entries), 'tenant-b', fetchRegion)).resolves.toBe('us');
    expect(fetchRegion).not.toHaveBeenCalled();
  });
});

describe('expiry helpers', () => {
  it('computes the absolute expiry from expires_in seconds', () => {
    expect(expiresAtFrom(300, 1_000)).toBe(301_000);
  });

  it('treats a token inside the skew window as expired', () => {
    expect(isExpired(301_000, 290_000)).toBe(false);
    expect(isExpired(301_000, 291_000)).toBe(true);
    expect(isExpired(301_000, 302_000)).toBe(true);
  });
});

describe('the served lib.js duplicate', () => {
  it('behaves exactly like lib.ts', async () => {
    const served = await import(SERVED_LIB_SPECIFIER);

    expect(served.tenantFromPath('/tenant-a/oauth2/callback')).toBe('tenant-a');
    expect(served.tenantFromPath('/tenant_a')).toBeUndefined();
    expect(served.regionKeyFor('tenant-a')).toBe(regionKeyFor('tenant-a'));
    expect(served.expiresAtFrom(300, 1_000)).toBe(expiresAtFrom(300, 1_000));
    expect(served.isExpired(301_000, 291_000)).toBe(isExpired(301_000, 291_000));
    await expect(served.pkceChallengeFrom(RFC7636_VERIFIER, webcrypto.subtle)).resolves.toBe(
      RFC7636_CHALLENGE,
    );
  });
});
