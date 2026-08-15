import type { AuthOutcome, BearerOutcome, RptClaims } from './types.js';

const BEARER_PREFIX = 'Bearer ';

function decodeJwtPayload(token: string): RptClaims | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return undefined;
  }

  try {
    const payload = Buffer.from(segments[1] ?? '', 'base64url').toString('utf8');
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as RptClaims;
  } catch {
    return undefined;
  }
}

function permissionNames(claims: RptClaims): Set<string> {
  const names = new Set<string>();
  for (const entry of claims.permissions ?? []) {
    if (typeof entry === 'string') {
      names.add(entry);
    } else if (typeof entry.rsname === 'string') {
      names.add(entry.rsname);
    }
  }
  return names;
}

export function authenticateBearer(authorization: string | undefined): BearerOutcome {
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return { kind: 'unauthorized', reason: 'Missing bearer token' };
  }

  if (!decodeJwtPayload(authorization.slice(BEARER_PREFIX.length))) {
    return { kind: 'unauthorized', reason: 'Bearer token is not a decodable JWT' };
  }

  return { kind: 'bearer-present' };
}

export function authorize(
  authorization: string | undefined,
  tenantId: string | undefined,
  nowSeconds: number,
): AuthOutcome {
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return { kind: 'unauthorized', reason: 'Missing bearer token' };
  }

  const claims = decodeJwtPayload(authorization.slice(BEARER_PREFIX.length));
  if (!claims) {
    return { kind: 'unauthorized', reason: 'Bearer token is not a decodable JWT' };
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes('client')) {
    return { kind: 'unauthorized', reason: 'Token audience is not client' };
  }

  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) {
    return { kind: 'unauthorized', reason: 'Token is expired' };
  }

  if (!tenantId) {
    return { kind: 'forbidden', reason: 'Missing x-tenant-id header' };
  }

  if (!permissionNames(claims).has(`acme.client:${tenantId}`)) {
    return { kind: 'forbidden', reason: `Token permissions do not cover tenant ${tenantId}` };
  }

  return { kind: 'authorized', tenantId };
}
