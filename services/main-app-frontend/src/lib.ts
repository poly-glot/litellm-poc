import type { RegionStore } from './types.js';

const TENANT_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function tenantFromPath(pathname: string): string | undefined {
  const [first = ''] = pathname.split('/').filter(Boolean);
  return TENANT_HANDLE_PATTERN.test(first) ? first : undefined;
}

export function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function createCodeVerifier(randomValues: Uint8Array): string {
  return base64UrlFromBytes(randomValues);
}

export async function pkceChallengeFrom(
  verifier: string,
  subtle: typeof crypto.subtle = crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlFromBytes(new Uint8Array(digest));
}

export function regionKeyFor(tenant: string): string {
  return `region:${tenant}`;
}

export async function resolveRegion(
  store: RegionStore,
  tenant: string,
  fetchRegion: (tenant: string) => Promise<string>,
): Promise<string> {
  const cached = store.getItem(regionKeyFor(tenant));
  if (cached) {
    return cached;
  }

  const region = await fetchRegion(tenant);
  store.setItem(regionKeyFor(tenant), region);
  return region;
}

export function expiresAtFrom(expiresInSeconds: number, nowMs: number): number {
  return nowMs + expiresInSeconds * 1000;
}

export function isExpired(expiresAtMs: number, nowMs: number, skewMs = 10_000): boolean {
  return expiresAtMs - skewMs <= nowMs;
}
