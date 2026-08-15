import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createIdentityServer } from './app.js';
import type { JwksKey, TokenResponse } from './types.js';

const CALLBACK_URI = 'http://localhost:4000/tenant-a/oauth2/callback';
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

let baseUrl = '';
let server: Server;

beforeAll(async () => {
  server = createIdentityServer();
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function pkcePair(): { challenge: string; verifier: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { challenge: createHash('sha256').update(verifier).digest('base64url'), verifier };
}

function authorizeUrl(challenge: string): string {
  const url = new URL(`${baseUrl}/eu/oidc/authorize`);
  url.searchParams.set('client_id', 'poc');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CALLBACK_URI);
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('state', 'state-123');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function postAuthorize(
  challenge: string,
  email: string,
  password: string,
): Promise<Response> {
  return fetch(`${baseUrl}/eu/oidc/authorize`, {
    body: new URLSearchParams({
      client_id: 'poc',
      code_challenge: challenge,
      email,
      password,
      redirect_uri: CALLBACK_URI,
      state: 'state-123',
    }).toString(),
    headers: FORM_HEADERS,
    method: 'POST',
    redirect: 'manual',
  });
}

async function signInForCode(challenge: string): Promise<string> {
  const response = await postAuthorize(challenge, 'admin_a@test.com', '123456');
  expect(response.status).toBe(302);

  const location = new URL(response.headers.get('location') ?? '');
  expect(location.searchParams.get('state')).toBe('state-123');

  return location.searchParams.get('code') ?? '';
}

async function postToken(fields: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/eu/oidc/token`, {
    body: new URLSearchParams(fields).toString(),
    headers: FORM_HEADERS,
    method: 'POST',
  });
}

async function exchangeCode(code: string, verifier: string): Promise<Response> {
  return postToken({
    client_id: 'poc',
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: CALLBACK_URI,
  });
}

async function obtainTokens(): Promise<TokenResponse> {
  const { challenge, verifier } = pkcePair();
  const code = await signInForCode(challenge);
  const response = await exchangeCode(code, verifier);
  expect(response.status).toBe(200);
  return (await response.json()) as TokenResponse;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('authorize', () => {
  it('renders the login form carrying the PKCE parameters', async () => {
    const { challenge } = pkcePair();
    const response = await fetch(authorizeUrl(challenge));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('action="/eu/oidc/authorize"');
    expect(html).toContain(`name="code_challenge" value="${challenge}"`);
    expect(html).toContain('name="state" value="state-123"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
  });

  it('rejects a wrong password without redirecting', async () => {
    const { challenge } = pkcePair();
    const response = await postAuthorize(challenge, 'admin_a@test.com', 'wrong-password');

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Invalid email or password');
  });
});

describe('code exchange', () => {
  it('exchanges a code plus verifier for Keycloak-shaped tokens', async () => {
    const tokens = await obtainTokens();

    expect(tokens.expires_in).toBe(900);
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('Bearer');

    const payload = decodeSegment(tokens.access_token.split('.')[1] ?? '');
    expect(payload.azp).toBe('poc');
    expect(payload.email).toBe('admin_a@test.com');
    expect(payload.iss).toBe('http://localhost:4018/eu/realms/acme');
    expect(payload.preferred_username).toBe('admin_a@test.com');
    expect(payload.sid).toBeTruthy();
    expect(payload.sub).toBeTruthy();
  });

  it('rejects a wrong code_verifier', async () => {
    const { challenge } = pkcePair();
    const code = await signInForCode(challenge);
    const response = await exchangeCode(code, 'not-the-verifier');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('refuses a code redeemed twice', async () => {
    const { challenge, verifier } = pkcePair();
    const code = await signInForCode(challenge);

    expect((await exchangeCode(code, verifier)).status).toBe(200);
    expect((await exchangeCode(code, verifier)).status).toBe(400);
  });
});

describe('jwks', () => {
  it('signs access tokens verifiably against the JWKS endpoint', async () => {
    const tokens = await obtainTokens();
    const [headerSegment, payloadSegment, signature] = tokens.access_token.split('.');
    const kid = decodeSegment(headerSegment ?? '').kid;

    const jwksResponse = await fetch(`${baseUrl}/eu/realms/acme/protocol/openid-connect/certs`);
    const jwks = (await jwksResponse.json()) as { keys: JwksKey[] };
    const jwk = jwks.keys.find((key) => key.kid === kid);

    expect(jwk).toBeDefined();
    expect(jwk).toMatchObject({ alg: 'RS256', kty: 'RSA', use: 'sig' });

    const publicKey = createPublicKey({
      format: 'jwk',
      key: { e: jwk?.e, kty: jwk?.kty, n: jwk?.n },
    });

    const verified = createVerify('RSA-SHA256')
      .update(`${headerSegment}.${payloadSegment}`)
      .verify(publicKey, signature ?? '', 'base64url');

    expect(verified).toBe(true);
  });
});

describe('refresh', () => {
  it('refreshes tokens and rotates the refresh token', async () => {
    const tokens = await obtainTokens();

    const response = await postToken({
      client_id: 'poc',
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(response.status).toBe(200);

    const refreshed = (await response.json()) as TokenResponse;
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await postToken({
      client_id: 'poc',
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(replay.status).toBe(400);
  });
});

describe('discovery', () => {
  it('names the regional endpoints and the client capabilities', async () => {
    const response = await fetch(`${baseUrl}/us/realms/acme/.well-known/openid-configuration`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorization_endpoint: 'http://localhost:4018/us/oidc/authorize',
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      issuer: 'http://localhost:4018/us/realms/acme',
      jwks_uri: 'http://localhost:4018/us/realms/acme/protocol/openid-connect/certs',
      registration_endpoint: 'http://localhost:4018/us/oidc/register',
      response_types_supported: ['code'],
      token_endpoint: 'http://localhost:4018/us/oidc/token',
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});

describe('dynamic client registration', () => {
  it('registers any loopback client as the fixed public client', async () => {
    const response = await fetch(`${baseUrl}/eu/oidc/register`, {
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:3334/oauth/callback'] }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      client_id: 'poc',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: ['http://127.0.0.1:3334/oauth/callback'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('rejects a registration without redirect uris', async () => {
    const response = await fetch(`${baseUrl}/eu/oidc/register`, {
      body: JSON.stringify({ redirect_uris: [] }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_client_metadata' });
  });

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${baseUrl}/eu/oidc/register`, {
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
  });
});

describe('cors preflight', () => {
  it('answers OPTIONS with the allowed methods and headers', async () => {
    const response = await fetch(`${baseUrl}/eu/oidc/register`, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST');
  });
});
