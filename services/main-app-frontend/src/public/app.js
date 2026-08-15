import {
  createCodeVerifier,
  expiresAtFrom,
  isExpired,
  pkceChallengeFrom,
  resolveRegion,
  tenantFromPath,
} from './lib.js';

const ACCESS_BASE = 'http://localhost:4014';
const CLIENT_ID = 'poc';
const DISCOVERY_BASE = 'http://localhost:4008';
const IDENTITY_BASE = 'http://localhost:4018';

const HTML_ESCAPES = { '"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;' };

const app = document.querySelector('#app');

function escapeHtml(value) {
  return String(value).replace(/["&'<>]/g, (char) => HTML_ESCAPES[char]);
}

function authKeyFor(tenant) {
  return `auth:${tenant}`;
}

function idpKeyFor(tenant) {
  return `idp:${tenant}`;
}

function rptKeyFor(tenant) {
  return `rpt:${tenant}`;
}

function readJson(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function decodeJwtPayload(token) {
  const [, payload = ''] = token.split('.');

  try {
    return JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    return {};
  }
}

function redirectUriFor(tenant) {
  return `${location.origin}/${tenant}/oauth2/callback`;
}

async function fetchRegion(tenant) {
  const response = await fetch(`${DISCOVERY_BASE}/region/${tenant}`);
  if (!response.ok) {
    throw new Error(`Discovery does not know tenant "${tenant}"`);
  }
  return (await response.text()).trim();
}

async function requestIdentityTokens(region, grant) {
  const response = await fetch(`${IDENTITY_BASE}/${region}/oidc/token`, {
    body: new URLSearchParams({ client_id: CLIENT_ID, ...grant }),
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`Token request failed with ${response.status}`);
  }

  return response.json();
}

function storeIdpTokens(tenant, tokens) {
  const record = {
    accessToken: tokens.access_token,
    expiresAt: expiresAtFrom(tokens.expires_in, Date.now()),
    refreshToken: tokens.refresh_token,
  };
  writeJson(idpKeyFor(tenant), record);
  return record;
}

async function mintRpt(tenant, idp) {
  const response = await fetch(`${ACCESS_BASE}/token`, {
    body: JSON.stringify({ audience: ['client'], permission: `acme.client:${tenant}` }),
    headers: { Authorization: `Bearer ${idp.accessToken}`, 'Content-Type': 'application/json' },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`RPT mint failed with ${response.status}`);
  }

  const minted = await response.json();
  const record = {
    expiresAt: expiresAtFrom(minted.expires_in, Date.now()),
    token: minted.access_token,
  };
  writeJson(rptKeyFor(tenant), record);
  return record;
}

async function refreshIdpTokens(tenant, region) {
  const idp = readJson(idpKeyFor(tenant));
  if (idp === undefined) {
    throw new Error('Not signed in');
  }

  const tokens = await requestIdentityTokens(region, {
    grant_type: 'refresh_token',
    refresh_token: idp.refreshToken,
  });
  return storeIdpTokens(tenant, tokens);
}

async function ensureFreshRpt(tenant, region) {
  const rpt = readJson(rptKeyFor(tenant));
  if (rpt !== undefined && !isExpired(rpt.expiresAt, Date.now())) {
    return rpt;
  }

  const idp = await refreshIdpTokens(tenant, region);
  return mintRpt(tenant, idp);
}

async function startSignIn(tenant, region) {
  const state = createCodeVerifier(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = createCodeVerifier(crypto.getRandomValues(new Uint8Array(32)));
  writeJson(authKeyFor(tenant), { state, verifier });

  const authorize = new URL(`${IDENTITY_BASE}/${region}/oidc/authorize`);
  authorize.searchParams.set('client_id', CLIENT_ID);
  authorize.searchParams.set('code_challenge', await pkceChallengeFrom(verifier));
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('redirect_uri', redirectUriFor(tenant));
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid');
  authorize.searchParams.set('state', state);

  location.assign(authorize.toString());
}

async function completeSignIn(tenant, region, query) {
  const pending = readJson(authKeyFor(tenant));
  localStorage.removeItem(authKeyFor(tenant));

  if (pending === undefined || pending.state !== query.get('state')) {
    throw new Error('Login state mismatch; sign in again');
  }

  const tokens = await requestIdentityTokens(region, {
    code: query.get('code') ?? '',
    code_verifier: pending.verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUriFor(tenant),
  });

  const idp = storeIdpTokens(tenant, tokens);
  await mintRpt(tenant, idp);

  history.replaceState(null, '', `/${tenant}`);
}

function signOut(tenant) {
  localStorage.removeItem(idpKeyFor(tenant));
  localStorage.removeItem(rptKeyFor(tenant));
}

function render(html) {
  app.innerHTML = html;
}

function renderMissingTenant() {
  render(`
    <h1>Acme Main App</h1>
    <p>Pick a tenant by visiting <code>/tenant-a</code>, <code>/tenant-b</code> or <code>/tenant-c</code>.</p>
  `);
}

function renderError(message) {
  render(`
    <h1>Acme Main App</h1>
    <p class="error">${escapeHtml(message)}</p>
  `);
}

function renderSignedOut(tenant, region, notice = '') {
  const noticeBlock = notice ? `<p class="error">${escapeHtml(notice)}</p>` : '';

  render(`
    <h1>Acme Main App</h1>
    <p><strong>${escapeHtml(tenant)}</strong> (${escapeHtml(region)}) &mdash; signed out</p>
    ${noticeBlock}
    <button data-sign-in>Sign in</button>
  `);

  document.querySelector('[data-sign-in]').addEventListener('click', () => {
    startSignIn(tenant, region).catch((error) => renderError(error.message));
  });
}

function renderSignedIn(tenant, region, rpt) {
  const idp = readJson(idpKeyFor(tenant)) ?? {};
  const claims = decodeJwtPayload(idp.accessToken ?? '');
  const rptExpiry = new Date(rpt.expiresAt).toLocaleTimeString();

  render(`
    <h1>Acme Main App</h1>
    <p>
      <strong>${escapeHtml(tenant)}</strong> (${escapeHtml(region)}) &mdash;
      signed in as ${escapeHtml(claims.email ?? 'unknown')}
    </p>
    <p>RPT valid until ${escapeHtml(rptExpiry)}</p>
    <button data-remint>Re-mint RPT</button>
    <button data-sign-out>Sign out</button>
  `);

  document.querySelector('[data-remint]').addEventListener('click', () => {
    remintSilently(tenant, region);
  });

  document.querySelector('[data-sign-out]').addEventListener('click', () => {
    signOut(tenant);
    renderSignedOut(tenant, region);
  });
}

function remintSilently(tenant, region) {
  ensureFreshRpt(tenant, region)
    .then((rpt) => renderSignedIn(tenant, region, rpt))
    .catch(() => {
      signOut(tenant);
      renderSignedOut(tenant, region, 'Session expired; sign in again');
    });
}

async function main() {
  const tenant = tenantFromPath(location.pathname);
  if (tenant === undefined) {
    renderMissingTenant();
    return;
  }

  const region = await resolveRegion(localStorage, tenant, fetchRegion);
  const query = new URLSearchParams(location.search);

  if (location.pathname.endsWith('/oauth2/callback') && query.has('code')) {
    await completeSignIn(tenant, region, query);
  }

  if (readJson(idpKeyFor(tenant)) === undefined) {
    renderSignedOut(tenant, region);
    return;
  }

  remintSilently(tenant, region);
}

main().catch((error) => {
  renderError(error instanceof Error ? error.message : String(error));
});
