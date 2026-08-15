import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import {
  CORS_ALLOW_ALL_ORIGIN,
  errorMessage,
  respondCorsPreflight,
  respondJson,
} from '@litellm-poc/core';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  createSigningKey,
  mintAccessToken,
  publicJwkFor,
} from './jwt.js';
import { renderLoginForm } from './loginForm.js';
import { createOidcStore } from './oidc.js';
import { authenticate } from './users.js';
import type { AuthorizeQuery, Region, Session, SigningKey, TokenResponse } from './types.js';

const CLIENT_ID = 'poc';
const REGION_ROUTE = /^\/(eu|us)(\/.+)$/;

const OAUTH_JSON_HEADERS = { ...CORS_ALLOW_ALL_ORIGIN, 'Cache-Control': 'no-store' };

interface IdentityContext {
  issuerBase: string;
  signingKey: SigningKey;
  store: ReturnType<typeof createOidcStore>;
}

export interface IdentityServerOptions {
  issuerBase?: string;
}

export function createIdentityServer(options: IdentityServerOptions = {}): Server {
  const context: IdentityContext = {
    issuerBase: options.issuerBase ?? process.env.ISSUER_BASE ?? 'http://localhost:4018',
    signingKey: createSigningKey(),
    store: createOidcStore(),
  };

  return createServer((request, response) => {
    void handleRequest(context, request, response);
  });
}

async function handleRequest(
  context: IdentityContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    await route(context, request, response);
  } catch (error) {
    respondOAuthJson(response, 500, { error: errorMessage(error) });
  }
}

async function route(
  context: IdentityContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method === 'OPTIONS') {
    return respondCorsPreflight(response);
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return respondOAuthJson(response, 200, { status: 'ok' });
  }

  const match = REGION_ROUTE.exec(url.pathname);
  const region = regionFrom(match?.[1]);
  const path = match?.[2];

  if (!region || !path) {
    return respondOAuthJson(response, 404, { error: 'Unknown route' });
  }

  switch (`${request.method} ${path}`) {
    case 'GET /oidc/authorize':
      return handleAuthorizeForm(region, url.searchParams, response);

    case 'POST /oidc/authorize':
      return handleLogin(context, region, new URLSearchParams(await text(request)), response);

    case 'POST /oidc/token':
      return handleToken(context, region, new URLSearchParams(await text(request)), response);

    case 'POST /oidc/register':
      return handleRegister(await text(request), response);

    case 'GET /realms/acme/protocol/openid-connect/certs':
      return respondOAuthJson(response, 200, { keys: [publicJwkFor(context.signingKey)] });

    case 'GET /realms/acme/.well-known/openid-configuration':
      return handleDiscovery(context, region, response);

    default:
      return respondOAuthJson(response, 404, { error: 'Unknown route' });
  }
}

function handleAuthorizeForm(
  region: Region,
  query: URLSearchParams,
  response: ServerResponse,
): void {
  const authorize = authorizeQueryFrom(query);
  const isCodeFlow = query.get('response_type') === 'code';
  const isS256 = query.get('code_challenge_method') === 'S256';

  if (!authorize || !isCodeFlow || !isS256) {
    return respondOAuthJson(response, 400, { error: 'invalid_request' });
  }

  respondHtml(response, 200, renderLoginForm(region, authorize));
}

function handleLogin(
  context: IdentityContext,
  region: Region,
  form: URLSearchParams,
  response: ServerResponse,
): void {
  const authorize = authorizeQueryFrom(form);
  if (!authorize) {
    return respondOAuthJson(response, 400, { error: 'invalid_request' });
  }

  const user = authenticate(form.get('email') ?? '', form.get('password') ?? '');
  if (!user) {
    return respondHtml(
      response,
      401,
      renderLoginForm(region, authorize, 'Invalid email or password'),
    );
  }

  const code = context.store.issueCode({
    clientId: authorize.clientId,
    codeChallenge: authorize.codeChallenge,
    email: user.email,
    redirectUri: authorize.redirectUri,
    region,
  });

  const location = new URL(authorize.redirectUri);
  location.searchParams.set('code', code);
  location.searchParams.set('state', authorize.state);

  response.writeHead(302, { Location: location.toString() });
  response.end();
}

function handleToken(
  context: IdentityContext,
  region: Region,
  form: URLSearchParams,
  response: ServerResponse,
): void {
  if (form.get('client_id') !== CLIENT_ID) {
    return respondOAuthJson(response, 400, { error: 'invalid_client' });
  }

  switch (form.get('grant_type')) {
    case 'authorization_code':
      return handleCodeGrant(context, region, form, response);

    case 'refresh_token':
      return handleRefreshGrant(context, region, form, response);

    default:
      return respondOAuthJson(response, 400, { error: 'unsupported_grant_type' });
  }
}

function handleCodeGrant(
  context: IdentityContext,
  region: Region,
  form: URLSearchParams,
  response: ServerResponse,
): void {
  const record = context.store.redeemCode({
    clientId: CLIENT_ID,
    code: form.get('code') ?? '',
    codeVerifier: form.get('code_verifier') ?? '',
    redirectUri: form.get('redirect_uri') ?? '',
    region,
  });

  if (!record) {
    return respondOAuthJson(response, 400, { error: 'invalid_grant' });
  }

  respondTokens(context, record, response);
}

function handleRefreshGrant(
  context: IdentityContext,
  region: Region,
  form: URLSearchParams,
  response: ServerResponse,
): void {
  const record = context.store.redeemRefreshToken(form.get('refresh_token') ?? '', region);

  if (!record) {
    return respondOAuthJson(response, 400, { error: 'invalid_grant' });
  }

  respondTokens(context, record, response);
}

function respondTokens(context: IdentityContext, session: Session, response: ServerResponse): void {
  const accessToken = mintAccessToken(context.signingKey, {
    clientId: session.clientId,
    email: session.email,
    issuer: issuerFor(context.issuerBase, session.region),
    sid: session.sid,
  });

  const refreshToken = context.store.issueRefreshToken({
    clientId: session.clientId,
    email: session.email,
    region: session.region,
    sid: session.sid,
  });

  const tokens: TokenResponse = {
    access_token: accessToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    token_type: 'Bearer',
  };

  respondOAuthJson(response, 200, tokens);
}

function handleRegister(body: string, response: ServerResponse): void {
  const redirectUris = redirectUrisFrom(body);

  if (!redirectUris) {
    return respondOAuthJson(response, 400, { error: 'invalid_client_metadata' });
  }

  respondOAuthJson(response, 201, {
    client_id: CLIENT_ID,
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: redirectUris,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

function redirectUrisFrom(body: string): string[] | undefined {
  try {
    const parsed = JSON.parse(body) as { redirect_uris?: unknown };
    const candidates = Array.isArray(parsed.redirect_uris) ? parsed.redirect_uris : [];
    const redirectUris = candidates.filter(
      (uri): uri is string => typeof uri === 'string' && URL.canParse(uri),
    );

    return redirectUris.length > 0 ? redirectUris : undefined;
  } catch {
    return undefined;
  }
}

function handleDiscovery(context: IdentityContext, region: Region, response: ServerResponse): void {
  respondOAuthJson(response, 200, {
    authorization_endpoint: `${context.issuerBase}/${region}/oidc/authorize`,
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    issuer: issuerFor(context.issuerBase, region),
    jwks_uri: `${context.issuerBase}/${region}/realms/acme/protocol/openid-connect/certs`,
    registration_endpoint: `${context.issuerBase}/${region}/oidc/register`,
    response_types_supported: ['code'],
    token_endpoint: `${context.issuerBase}/${region}/oidc/token`,
    token_endpoint_auth_methods_supported: ['none'],
  });
}

function authorizeQueryFrom(params: URLSearchParams): AuthorizeQuery | undefined {
  const clientId = params.get('client_id');
  const codeChallenge = params.get('code_challenge');
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');

  if (clientId !== CLIENT_ID || !codeChallenge || !redirectUri || !state) {
    return undefined;
  }

  if (!URL.canParse(redirectUri)) {
    return undefined;
  }

  return { clientId, codeChallenge, redirectUri, state };
}

function issuerFor(issuerBase: string, region: Region): string {
  return `${issuerBase}/${region}/realms/acme`;
}

function regionFrom(value: string | undefined): Region | undefined {
  return value === 'eu' || value === 'us' ? value : undefined;
}

function respondHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}

function respondOAuthJson(response: ServerResponse, status: number, payload: unknown): void {
  respondJson(response, status, payload, OAUTH_JSON_HEADERS);
}
