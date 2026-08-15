import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAccessServer } from './app.js';
import { decodeJwt, signJwt, verifyJwtSignature } from './jwt.js';
import type { Jwk, Jwks, JwtClaims, TokenResponse } from './types.js';

const IDP_KID = 'idp-test-key';
const JWKS_PATH = '/eu/realms/acme/protocol/openid-connect/certs';

let accessPort = 0;
let accessServer: Server;
let idpPrivateKey: KeyObject;
let issuer = '';
let jwksServer: Server;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('server has no port');
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function mintIdpToken(overrides: JwtClaims = {}, privateKey: KeyObject = idpPrivateKey): string {
  return signJwt(
    { alg: 'RS256', kid: IDP_KID, typ: 'JWT' },
    {
      email: 'admin_a@test.com',
      exp: nowSeconds() + 3600,
      iss: issuer,
      preferred_username: 'admin_a@test.com',
      ...overrides,
    },
    privateKey,
  );
}

async function requestToken(
  authorization: string | undefined,
  body: unknown,
): Promise<{ payload: unknown; status: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authorization !== undefined) {
    headers.Authorization = authorization;
  }

  const response = await fetch(`http://localhost:${accessPort}/token`, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    method: 'POST',
  });

  return { payload: await response.json(), status: response.status };
}

function tokenRequestBody(handle: string): { audience: string[]; permission: string } {
  return { audience: ['client'], permission: `acme.client:${handle}` };
}

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  idpPrivateKey = privateKey;
  const idpJwk: Jwk = {
    ...(publicKey.export({ format: 'jwk' }) as Jwk),
    alg: 'RS256',
    kid: IDP_KID,
    use: 'sig',
  };

  jwksServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === JWKS_PATH) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ keys: [idpJwk] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const jwksPort = await listen(jwksServer);
  issuer = `http://localhost:${jwksPort}/eu/realms/acme`;

  accessServer = createAccessServer({
    issuerAllowlistPrefix: `http://localhost:${jwksPort}`,
    rptIssuer: 'http://localhost:0',
  });
  accessPort = await listen(accessServer);
});

afterAll(async () => {
  await close(accessServer);
  await close(jwksServer);
});

describe('POST /token', () => {
  it('returns 200 with a signed RPT for an entitled tenant', async () => {
    const { payload, status } = await requestToken(
      `Bearer ${mintIdpToken()}`,
      tokenRequestBody('tenant-a'),
    );

    expect(status).toBe(200);
    const { access_token, expires_in } = payload as TokenResponse;
    expect(expires_in).toBe(300);

    const decoded = decodeJwt(access_token);
    if (!decoded) {
      throw new Error('RPT did not decode');
    }

    expect(decoded.header.alg).toBe('RS256');
    expect(decoded.claims.aud).toBe('client');
    expect(decoded.claims.sub).toBe('admin_a@test.com');
    expect(decoded.claims.permissions).toEqual([
      { rsname: 'acme.client:tenant-a', scopes: ['access'] },
    ]);
    expect(decoded.claims.exp).toBe((decoded.claims.iat ?? 0) + 300);

    const jwksResponse = await fetch(`http://localhost:${accessPort}/.well-known/jwks.json`);
    const { keys } = (await jwksResponse.json()) as Jwks;
    const rptJwk = keys.find((key) => key.kid === decoded.header.kid);
    if (!rptJwk) {
      throw new Error('RPT kid not present in the access JWKS');
    }

    expect(verifyJwtSignature(decoded, rptJwk)).toBe(true);
  });

  it('matches entitlement on preferred_username when email is absent', async () => {
    const token = mintIdpToken({ email: undefined, preferred_username: 'admin_b@test.com' });
    const { status } = await requestToken(`Bearer ${token}`, tokenRequestBody('tenant-b'));

    expect(status).toBe(200);
  });

  it('returns 403 when the token holder is not entitled to the tenant', async () => {
    const { status } = await requestToken(`Bearer ${mintIdpToken()}`, tokenRequestBody('tenant-b'));

    expect(status).toBe(403);
  });

  it('returns 403 for a verified token with no known identity', async () => {
    const token = mintIdpToken({ email: 'stranger@test.com', preferred_username: 'stranger' });
    const { status } = await requestToken(`Bearer ${token}`, tokenRequestBody('tenant-a'));

    expect(status).toBe(403);
  });

  it('returns 401 for a garbage bearer', async () => {
    const { status } = await requestToken('Bearer garbage', tokenRequestBody('tenant-a'));

    expect(status).toBe(401);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const { status } = await requestToken(undefined, tokenRequestBody('tenant-a'));

    expect(status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const token = mintIdpToken({ exp: nowSeconds() - 60 });
    const { status } = await requestToken(`Bearer ${token}`, tokenRequestBody('tenant-a'));

    expect(status).toBe(401);
  });

  it('returns 401 for an issuer outside the allowlist', async () => {
    const token = mintIdpToken({ iss: 'http://localhost:1/eu/realms/acme' });
    const { status } = await requestToken(`Bearer ${token}`, tokenRequestBody('tenant-a'));

    expect(status).toBe(401);
  });

  it('returns 401 for a token signed by a key outside the JWKS', async () => {
    const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = mintIdpToken({}, rogue.privateKey);
    const { status } = await requestToken(`Bearer ${token}`, tokenRequestBody('tenant-a'));

    expect(status).toBe(401);
  });

  it('returns 400 for a body that is not JSON', async () => {
    const { status } = await requestToken(`Bearer ${mintIdpToken()}`, 'not json');

    expect(status).toBe(400);
  });

  it('returns 400 for a malformed permission string', async () => {
    const { payload, status } = await requestToken(`Bearer ${mintIdpToken()}`, {
      audience: ['client'],
      permission: 'acme.client:Tenant_A',
    });

    expect(status).toBe(400);
    expect(payload).not.toHaveProperty('access_token');
  });

  it('returns 400 when the audience does not include client', async () => {
    const { status } = await requestToken(`Bearer ${mintIdpToken()}`, {
      audience: [],
      permission: 'acme.client:tenant-a',
    });

    expect(status).toBe(400);
  });
});
