import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';

import { CORS_ALLOW_ALL_ORIGIN, TENANT_REGIONS } from '@litellm-poc/core';

import type { Region } from './types.js';

const REGION_PATH_PREFIX = '/region/';

export function resolveRegion(handle: string): Region | undefined {
  return TENANT_REGIONS.get(handle);
}

function respondPlainText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { ...CORS_ALLOW_ALL_ORIGIN, 'Content-Type': 'text/plain' });
  response.end(body);
}

export function createDiscoveryServer(): Server {
  return createServer((request, response) => {
    const url = request.url ?? '';
    const isRegionLookup = request.method === 'GET' && url.startsWith(REGION_PATH_PREFIX);

    if (!isRegionLookup) {
      respondPlainText(response, 404, '');
      return;
    }

    const region = resolveRegion(url.slice(REGION_PATH_PREFIX.length));

    if (region === undefined) {
      respondPlainText(response, 404, '');
      return;
    }

    respondPlainText(response, 200, region);
  });
}
