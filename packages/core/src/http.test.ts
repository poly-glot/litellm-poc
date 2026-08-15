import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORS_ALLOW_ALL_ORIGIN, errorMessage, respondJson } from './http.js';

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

describe('respondJson', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/plain') {
        return respondJson(response, 201, { created: true });
      }

      respondJson(response, 403, { error: 'nope' }, CORS_ALLOW_ALL_ORIGIN);
    });
    url = await listen(server);
  });

  afterAll(async () => {
    await close(server);
  });

  it('serialises the payload with a JSON content type', async () => {
    const response = await fetch(`${url}/plain`);

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ created: true });
  });

  it('leaves extra headers to the caller', async () => {
    const plain = await fetch(`${url}/plain`);

    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('merges caller-supplied headers', async () => {
    const response = await fetch(`${url}/cors`);

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({ error: 'nope' });
  });
});

describe('errorMessage', () => {
  it('unwraps Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies everything else', () => {
    expect(errorMessage('plain failure')).toBe('plain failure');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
