import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMainAppServer } from './app.js';
import type { ChatCompletionRequest } from './types.js';

interface RecordedGatewayCall {
  authorization: string | undefined;
  body: ChatCompletionRequest;
  url: string | undefined;
}

interface CannedGatewayResponse {
  body: string;
  status: number;
}

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

const successBody = JSON.stringify({
  choices: [{ message: { content: 'pong' } }],
  model: 'qwen3-local',
});

describe('main-app server', () => {
  const gatewayCalls: RecordedGatewayCall[] = [];
  let appServer: Server;
  let appUrl: string;
  let gatewayResponse: CannedGatewayResponse;
  let gatewayServer: Server;

  beforeAll(async () => {
    gatewayServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk as Buffer);
      }

      gatewayCalls.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatCompletionRequest,
        url: request.url,
      });

      response.writeHead(gatewayResponse.status, { 'Content-Type': 'application/json' });
      response.end(gatewayResponse.body);
    });
    const gatewayUrl = await listen(gatewayServer);

    appServer = createMainAppServer({ apiKey: 'test-key', gatewayUrl, model: 'qwen3-local' });
    appUrl = await listen(appServer);
  });

  afterAll(async () => {
    await Promise.all([close(appServer), close(gatewayServer)]);
  });

  beforeEach(() => {
    gatewayCalls.length = 0;
    gatewayResponse = { body: successBody, status: 200 };
  });

  it('answers /healthz', async () => {
    const response = await fetch(`${appUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('relays /chat through the gateway with both tags and the configured model', async () => {
    const response = await fetch(`${appUrl}/chat`, {
      body: JSON.stringify({ prompt: 'ping', tenant: 'tenant-a' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reply: 'pong' });

    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]?.url).toBe('/v1/chat/completions');
    expect(gatewayCalls[0]?.authorization).toBe('Bearer test-key');
    expect(gatewayCalls[0]?.body).toEqual({
      messages: [{ content: 'ping', role: 'user' }],
      metadata: { tags: ['agent:main-app', 'tenant:tenant-a'] },
      model: 'qwen3-local',
    });
  });

  it.each([
    ['a missing prompt', { tenant: 'tenant-a' }],
    ['a missing tenant', { prompt: 'ping' }],
  ])('rejects %s with 400 before calling the gateway', async (_label, body) => {
    const response = await fetch(`${appUrl}/chat`, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
    expect(gatewayCalls).toHaveLength(0);
  });

  it('passes a gateway error status through with a JSON error body', async () => {
    gatewayResponse = { body: JSON.stringify({ error: 'tag rejected' }), status: 400 };

    const response = await fetch(`${appUrl}/chat`, {
      body: JSON.stringify({ prompt: 'ping', tenant: 'tenant-a' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
  });
});
