import { decodeJwt, verifyJwtSignature } from './jwt.js';
import type { ExchangeDeps, ExchangeResult, Jwks, JwtClaims } from './types.js';

const BEARER_PREFIX = 'Bearer ';
const PERMISSION_PATTERN = /^acme\.client:([a-z0-9][a-z0-9-]*)$/;

interface TokenRequest {
  handle: string;
}

interface TokenRequestBody {
  audience?: unknown;
  permission?: unknown;
}

function parseTokenRequest(rawBody: string): TokenRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const { audience, permission } = parsed as TokenRequestBody;
  if (!Array.isArray(audience) || !audience.includes('client')) {
    return undefined;
  }
  if (typeof permission !== 'string') {
    return undefined;
  }

  const handle = PERMISSION_PATTERN.exec(permission)?.[1];
  return handle === undefined ? undefined : { handle };
}

function extractBearer(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return undefined;
  }

  const bearer = authorization.slice(BEARER_PREFIX.length).trim();
  return bearer === '' ? undefined : bearer;
}

async function fetchJwks(issuer: string): Promise<Jwks | undefined> {
  try {
    const response = await fetch(`${issuer.replace(/\/+$/, '')}/protocol/openid-connect/certs`);
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as Jwks;
  } catch {
    return undefined;
  }
}

async function verifyIdpToken(
  issuerAllowlistPrefix: string,
  bearer: string,
): Promise<JwtClaims | undefined> {
  const decoded = decodeJwt(bearer);
  if (!decoded || decoded.header.alg !== 'RS256') {
    return undefined;
  }

  const { claims } = decoded;
  if (typeof claims.iss !== 'string' || !claims.iss.startsWith(issuerAllowlistPrefix)) {
    return undefined;
  }
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    return undefined;
  }

  const jwks = await fetchJwks(claims.iss);
  if (!jwks || !Array.isArray(jwks.keys)) {
    return undefined;
  }

  const jwk = jwks.keys.find((key) => key.kid === decoded.header.kid);
  if (!jwk) {
    return undefined;
  }

  return verifyJwtSignature(decoded, jwk) ? claims : undefined;
}

function entitledIdentity(
  entitlements: ReadonlyMap<string, string>,
  claims: JwtClaims,
  handle: string,
): string | undefined {
  const candidates = [claims.email, claims.preferred_username];
  return candidates.find(
    (identity) => identity !== undefined && entitlements.get(identity) === handle,
  );
}

export async function exchangeToken(
  deps: ExchangeDeps,
  authorization: string | undefined,
  rawBody: string,
): Promise<ExchangeResult> {
  const request = parseTokenRequest(rawBody);
  if (!request) {
    return { body: { error: 'Malformed body or permission string' }, status: 400 };
  }

  const bearer = extractBearer(authorization);
  if (!bearer) {
    return { body: { error: 'Missing bearer token' }, status: 401 };
  }

  const claims = await verifyIdpToken(deps.issuerAllowlistPrefix, bearer);
  if (!claims) {
    return { body: { error: 'Unverifiable bearer token' }, status: 401 };
  }

  const identity = entitledIdentity(deps.entitlements, claims, request.handle);
  if (!identity) {
    return { body: { error: 'Not entitled to this tenant' }, status: 403 };
  }

  return { body: deps.mintRpt(identity, request.handle), status: 200 };
}
