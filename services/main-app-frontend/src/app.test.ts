import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFrontendServer } from './app.js';

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('main-app-frontend server', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createFrontendServer();
    baseUrl = await listen(server);
  });

  afterAll(async () => {
    await close(server);
  });

  it('answers /healthz', async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it.each([['/'], ['/tenant-a'], ['/tenant-a/oauth2/callback'], ['/unknown/deep/path']])(
    'serves the HTML shell for %s',
    async (path) => {
      const response = await fetch(`${baseUrl}${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await response.text()).toContain('<main id="app">');
    },
  );

  it('serves the browser app module', async () => {
    const response = await fetch(`${baseUrl}/app.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await response.text()).toContain("from './lib.js'");
  });

  it('serves the browser lib module', async () => {
    const response = await fetch(`${baseUrl}/lib.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await response.text()).toContain('pkceChallengeFrom');
  });

  it('rejects non-GET requests with 405', async () => {
    const response = await fetch(baseUrl, { method: 'POST' });

    expect(response.status).toBe(405);
  });
});
