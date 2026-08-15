import { createPublicKey, createVerify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  createSigningKey,
  mintAccessToken,
  publicJwkFor,
} from './jwt.js';
import type { AccessTokenInput } from './types.js';

const INPUT: AccessTokenInput = {
  clientId: 'poc',
  email: 'admin_a@test.com',
  issuer: 'http://localhost:4018/eu/realms/acme',
  sid: 'sid-1',
};

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('mintAccessToken', () => {
  it('produces a Keycloak-shaped RS256 JWT', () => {
    const key = createSigningKey();
    const [headerSegment, payloadSegment] = mintAccessToken(key, INPUT).split('.');

    expect(decodeSegment(headerSegment ?? '')).toEqual({ alg: 'RS256', kid: key.kid, typ: 'JWT' });

    const payload = decodeSegment(payloadSegment ?? '');
    expect(payload.aud).toBe('account');
    expect(payload.azp).toBe('poc');
    expect(payload.email).toBe('admin_a@test.com');
    expect(payload.iss).toBe('http://localhost:4018/eu/realms/acme');
    expect(payload.preferred_username).toBe('admin_a@test.com');
    expect(payload.realm_access).toEqual({
      roles: ['default-roles-acme', 'offline_access', 'uma_authorization'],
    });
    expect(payload.resource_access).toEqual({
      account: { roles: ['manage-account', 'view-profile'] },
    });
    expect(payload.sid).toBe('sid-1');
    expect(Number(payload.exp) - Number(payload.iat)).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('mints a stable subject per email', () => {
    const key = createSigningKey();
    const subjectOf = (token: string) => decodeSegment(token.split('.')[1] ?? '').sub;

    expect(subjectOf(mintAccessToken(key, INPUT))).toBe(subjectOf(mintAccessToken(key, INPUT)));
  });

  it('signs verifiably against the exported JWK', () => {
    const key = createSigningKey();
    const token = mintAccessToken(key, INPUT);
    const [headerSegment, payloadSegment, signature] = token.split('.');

    const jwk = publicJwkFor(key);
    const publicKey = createPublicKey({ format: 'jwk', key: { e: jwk.e, kty: jwk.kty, n: jwk.n } });

    const verified = createVerify('RSA-SHA256')
      .update(`${headerSegment}.${payloadSegment}`)
      .verify(publicKey, signature ?? '', 'base64url');

    expect(verified).toBe(true);
  });
});
