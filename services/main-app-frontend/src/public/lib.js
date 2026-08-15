const TENANT_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function tenantFromPath(pathname) {
  const [first = ''] = pathname.split('/').filter(Boolean);
  return TENANT_HANDLE_PATTERN.test(first) ? first : undefined;
}

export function base64UrlFromBytes(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function createCodeVerifier(randomValues) {
  return base64UrlFromBytes(randomValues);
}

export async function pkceChallengeFrom(verifier, subtle = crypto.subtle) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlFromBytes(new Uint8Array(digest));
}

export function regionKeyFor(tenant) {
  return `region:${tenant}`;
}

export async function resolveRegion(store, tenant, fetchRegion) {
  const cached = store.getItem(regionKeyFor(tenant));
  if (cached) {
    return cached;
  }

  const region = await fetchRegion(tenant);
  store.setItem(regionKeyFor(tenant), region);
  return region;
}

export function expiresAtFrom(expiresInSeconds, nowMs) {
  return nowMs + expiresInSeconds * 1000;
}

export function isExpired(expiresAtMs, nowMs, skewMs = 10_000) {
  return expiresAtMs - skewMs <= nowMs;
}
