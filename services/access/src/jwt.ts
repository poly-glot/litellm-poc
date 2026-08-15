import { createPublicKey, sign, verify } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';

import type { DecodedJwt, Jwk, JwtClaims, JwtHeader } from './types.js';

const SIGNING_ALGORITHM = 'RSA-SHA256';

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeSegment<T>(segment: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

export function signJwt(header: JwtHeader, claims: JwtClaims, privateKey: KeyObject): string {
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const signature = sign(SIGNING_ALGORITHM, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function decodeJwt(token: string): DecodedJwt | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return undefined;
  }

  const [headerSegment, claimsSegment, signatureSegment] = segments;
  if (!headerSegment || !claimsSegment || !signatureSegment) {
    return undefined;
  }

  const header = decodeSegment<JwtHeader>(headerSegment);
  const claims = decodeSegment<JwtClaims>(claimsSegment);
  if (!header || !claims) {
    return undefined;
  }

  return {
    claims,
    header,
    signature: Buffer.from(signatureSegment, 'base64url'),
    signingInput: `${headerSegment}.${claimsSegment}`,
  };
}

export function verifyJwtSignature(decoded: DecodedJwt, jwk: Jwk): boolean {
  try {
    const publicKey = createPublicKey({ format: 'jwk', key: jwk as JsonWebKey });
    return verify(
      SIGNING_ALGORITHM,
      Buffer.from(decoded.signingInput),
      publicKey,
      decoded.signature,
    );
  } catch {
    return false;
  }
}
