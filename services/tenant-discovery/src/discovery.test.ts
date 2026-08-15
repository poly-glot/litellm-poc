import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDiscoveryServer } from './discovery.js';

const server = createDiscoveryServer();
let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('GET /region/<handle>', () => {
  it('returns eu for tenant-a with status 200', async () => {
    const response = await fetch(`${baseUrl}/region/tenant-a`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('eu');
  });

  it('returns us for tenant-b', async () => {
    const response = await fetch(`${baseUrl}/region/tenant-b`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('us');
  });

  it('returns eu for tenant-c', async () => {
    const response = await fetch(`${baseUrl}/region/tenant-c`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('eu');
  });

  it('returns 404 with an empty body for an unknown handle', async () => {
    const response = await fetch(`${baseUrl}/region/tenant-z`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('returns 404 with an empty body for any other path', async () => {
    const response = await fetch(`${baseUrl}/other`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('serves responses as text/plain', async () => {
    const response = await fetch(`${baseUrl}/region/tenant-a`);
    expect(response.headers.get('content-type')).toBe('text/plain');
  });
});
