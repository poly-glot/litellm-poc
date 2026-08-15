import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import type { Server, ServerResponse } from 'node:http';

import { respondJson } from '@litellm-poc/core';

import { handleMcp } from './mcp.js';
import { handleRest } from './rest.js';
import type { ProjectStore } from './store.js';
import type { McpResponse, ProtectedResourceMetadata } from './types.js';

const PROTECTED_RESOURCE_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]);

function respondMcp(response: ServerResponse, result: McpResponse): void {
  if (result.body === undefined) {
    response.writeHead(result.status, result.headers);
    response.end();
    return;
  }

  response.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers });
  response.end(JSON.stringify(result.body));
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createAcmeServer(
  store: ProjectStore,
  protectedResource: ProtectedResourceMetadata,
): Server {
  return createServer(async (request, response) => {
    const { headers, method = 'GET', url = '/' } = request;
    const path = url.split('?')[0] ?? '/';

    if (method === 'GET' && path === '/healthz') {
      return respondJson(response, 200, { status: 'ok' });
    }

    if (method === 'GET' && PROTECTED_RESOURCE_PATHS.has(path)) {
      return respondJson(response, 200, protectedResource);
    }

    if (path === '/mcp') {
      return respondMcp(
        response,
        handleMcp(store, {
          authorization: singleHeader(headers.authorization),
          body: await text(request),
          method,
          tenantId: singleHeader(headers['x-tenant-id']),
          tenantRegion: singleHeader(headers['x-tenant-region']),
        }),
      );
    }

    const result = handleRest(store, {
      body: await text(request),
      method,
      path,
      tenantId: singleHeader(headers['x-tenant-id']),
    });
    respondJson(response, result.status, result.body);
  });
}
