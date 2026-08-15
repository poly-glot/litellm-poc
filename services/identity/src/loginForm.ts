import type { AuthorizeQuery, Region } from './types.js';

const HTML_ESCAPES: Record<string, string> = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

function escapeHtml(value: string): string {
  return value.replace(/["&'<>]/g, (char) => HTML_ESCAPES[char] ?? char);
}

function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

export function renderLoginForm(
  region: Region,
  authorize: AuthorizeQuery,
  errorMessage = '',
): string {
  const errorBlock = errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Acme sign in (${region})</title></head>
<body>
<h1>Sign in to Acme (${region})</h1>
${errorBlock}
<form action="/${region}/oidc/authorize" method="post">
${hiddenInput('client_id', authorize.clientId)}
${hiddenInput('redirect_uri', authorize.redirectUri)}
${hiddenInput('state', authorize.state)}
${hiddenInput('code_challenge', authorize.codeChallenge)}
<label>Email <input name="email" type="email" required></label>
<label>Password <input name="password" type="password" required></label>
<button type="submit">Sign in</button>
</form>
</body>
</html>`;
}
