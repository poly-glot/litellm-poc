import { describe, expect, it } from 'vitest';

import { codeChallengeFrom, createOidcStore } from './oidc.js';
import type { CodeGrant, CodeRedemption, Session } from './types.js';

const GRANT: CodeGrant = {
  clientId: 'poc',
  codeChallenge: codeChallengeFrom('verifier-1'),
  email: 'admin_a@test.com',
  redirectUri: 'http://localhost:4000/tenant-a/oauth2/callback',
  region: 'eu',
};

const SESSION: Session = {
  clientId: 'poc',
  email: 'admin_a@test.com',
  region: 'eu',
  sid: 'sid-1',
};

function redemptionFor(code: string, codeVerifier = 'verifier-1'): CodeRedemption {
  return {
    clientId: GRANT.clientId,
    code,
    codeVerifier,
    redirectUri: GRANT.redirectUri,
    region: GRANT.region,
  };
}

describe('authorization codes', () => {
  it('redeems a code exactly once with the matching verifier', () => {
    const store = createOidcStore();
    const code = store.issueCode(GRANT);

    const record = store.redeemCode(redemptionFor(code));

    expect(record?.email).toBe('admin_a@test.com');
    expect(record?.sid).toBeTruthy();
    expect(store.redeemCode(redemptionFor(code))).toBeUndefined();
  });

  it('rejects a wrong verifier and burns the code', () => {
    const store = createOidcStore();
    const code = store.issueCode(GRANT);

    expect(store.redeemCode(redemptionFor(code, 'wrong-verifier'))).toBeUndefined();
    expect(store.redeemCode(redemptionFor(code))).toBeUndefined();
  });

  it('rejects an expired code', () => {
    let clock = 0;
    const store = createOidcStore(() => clock);
    const code = store.issueCode(GRANT);

    clock = 60_001;

    expect(store.redeemCode(redemptionFor(code))).toBeUndefined();
  });

  it('rejects a cross-region redemption', () => {
    const store = createOidcStore();
    const code = store.issueCode(GRANT);

    expect(store.redeemCode({ ...redemptionFor(code), region: 'us' })).toBeUndefined();
  });
});

describe('refresh tokens', () => {
  it('redeems a refresh token exactly once', () => {
    const store = createOidcStore();
    const token = store.issueRefreshToken(SESSION);

    expect(store.redeemRefreshToken(token, 'eu')?.sid).toBe('sid-1');
    expect(store.redeemRefreshToken(token, 'eu')).toBeUndefined();
  });

  it('rejects a cross-region refresh redemption', () => {
    const store = createOidcStore();
    const token = store.issueRefreshToken(SESSION);

    expect(store.redeemRefreshToken(token, 'us')).toBeUndefined();
  });

  it('rejects an expired refresh token', () => {
    let clock = 0;
    const store = createOidcStore(() => clock);
    const token = store.issueRefreshToken(SESSION);

    clock = 1_800_001;

    expect(store.redeemRefreshToken(token, 'eu')).toBeUndefined();
  });
});
