import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  CodeGrant,
  CodeRecord,
  CodeRedemption,
  RefreshRecord,
  Region,
  Session,
} from './types.js';

const CODE_TTL_MS = 60_000;
const REFRESH_TOKEN_TTL_MS = 1_800_000;

export function codeChallengeFrom(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export function createOidcStore(now: () => number = Date.now) {
  const codes = new Map<string, CodeRecord>();
  const refreshTokens = new Map<string, RefreshRecord>();

  function issueCode(grant: CodeGrant): string {
    const code = randomBytes(32).toString('base64url');
    codes.set(code, { ...grant, expiresAt: now() + CODE_TTL_MS, sid: randomUUID() });
    return code;
  }

  function redeemCode(redemption: CodeRedemption): CodeRecord | undefined {
    const record = codes.get(redemption.code);
    if (!record) {
      return undefined;
    }

    codes.delete(redemption.code);

    const matches =
      record.clientId === redemption.clientId &&
      record.codeChallenge === codeChallengeFrom(redemption.codeVerifier) &&
      record.expiresAt > now() &&
      record.redirectUri === redemption.redirectUri &&
      record.region === redemption.region;

    return matches ? record : undefined;
  }

  function issueRefreshToken(session: Session): string {
    const token = randomBytes(32).toString('base64url');

    refreshTokens.set(token, {
      clientId: session.clientId,
      email: session.email,
      expiresAt: now() + REFRESH_TOKEN_TTL_MS,
      region: session.region,
      sid: session.sid,
    });

    return token;
  }

  function redeemRefreshToken(token: string, region: Region): RefreshRecord | undefined {
    const record = refreshTokens.get(token);
    if (!record) {
      return undefined;
    }

    refreshTokens.delete(token);

    return record.expiresAt > now() && record.region === region ? record : undefined;
  }

  return { issueCode, issueRefreshToken, redeemCode, redeemRefreshToken };
}
