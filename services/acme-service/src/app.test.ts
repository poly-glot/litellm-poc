import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAcmeServer } from './app.js';
import { createProjectStore } from './store.js';
import type { ProtectedResourceMetadata } from './types.js';

const PROTECTED_RESOURCE: ProtectedResourceMetadata = {
  authorization_servers: [
    'http://localhost:4018/eu/realms/acme',
    'http://localhost:4018/us/realms/acme',
  ],
  bearer_methods_supported: ['header'],
  resource: 'http://localhost:4010/',
};

let baseUrl = '';
let server: Server;

beforeAll(async () => {
  server = createAcmeServer(createProjectStore(), PROTECTED_RESOURCE);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('protected resource metadata', () => {
  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])(
    'serves the RFC 9728 document on %s',
    async (path) => {
      const response = await fetch(`${baseUrl}${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual(PROTECTED_RESOURCE);
    },
  );

  it('keeps healthz unauthenticated and unchanged', async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('leaves unknown well-known paths to the REST handler', async () => {
    const response = await fetch(`${baseUrl}/.well-known/unknown`);

    expect(response.status).toBe(400);
  });
});
