import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

import type { AccessTokenInput, JwksKey, SigningKey } from './types.js';

export const ACCESS_TOKEN_TTL_SECONDS = 900;

const ACCOUNT_ROLES = ['manage-account', 'view-profile'];
const REALM_ROLES = ['default-roles-acme', 'offline_access', 'uma_authorization'];

export function createSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { e, n } = publicKey.export({ format: 'jwk' });

  if (!e || !n) {
    throw new Error('RSA JWK export produced no modulus or exponent');
  }

  return { e, kid: randomBytes(16).toString('base64url'), n, privateKey };
}

export function publicJwkFor(key: SigningKey): JwksKey {
  return { alg: 'RS256', e: key.e, kid: key.kid, kty: 'RSA', n: key.n, use: 'sig' };
}

export function mintAccessToken(key: SigningKey, input: AccessTokenInput): string {
  const issuedAt = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', kid: key.kid, typ: 'JWT' };
  const payload = {
    aud: 'account',
    azp: input.clientId,
    email: input.email,
    exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
    iat: issuedAt,
    iss: input.issuer,
    preferred_username: input.email,
    realm_access: { roles: REALM_ROLES },
    resource_access: { account: { roles: ACCOUNT_ROLES } },
    scope: 'openid email profile',
    sid: input.sid,
    sub: subjectFor(input.email),
    typ: 'Bearer',
  };

  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.privateKey, 'base64url');

  return `${signingInput}.${signature}`;
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function subjectFor(email: string): string {
  const digest = createHash('sha256').update(email).digest('hex');

  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join('-');
}
