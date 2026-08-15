import type { KeyObject } from 'node:crypto';

import type { Region } from '@litellm-poc/core';

export type { FixtureUser, Region } from '@litellm-poc/core';

export interface AccessTokenInput {
  clientId: string;
  email: string;
  issuer: string;
  sid: string;
}

export interface AuthorizeQuery {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state: string;
}

export interface CodeGrant {
  clientId: string;
  codeChallenge: string;
  email: string;
  redirectUri: string;
  region: Region;
}

export interface CodeRecord extends Session {
  codeChallenge: string;
  expiresAt: number;
  redirectUri: string;
}

export interface CodeRedemption {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  region: Region;
}

export interface JwksKey {
  alg: 'RS256';
  e: string;
  kid: string;
  kty: 'RSA';
  n: string;
  use: 'sig';
}

export interface RefreshRecord extends Session {
  expiresAt: number;
}

export interface Session {
  clientId: string;
  email: string;
  region: Region;
  sid: string;
}

export interface SigningKey {
  e: string;
  kid: string;
  n: string;
  privateKey: KeyObject;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: 'Bearer';
}
