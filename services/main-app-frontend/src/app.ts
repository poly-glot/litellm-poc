import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';

import { errorMessage, respondJson } from '@litellm-poc/core';

interface StaticAsset {
  contentType: string;
  fileName: string;
}

const PUBLIC_DIR = new URL('public/', import.meta.url);

const INDEX_ASSET: StaticAsset = {
  contentType: 'text/html; charset=utf-8',
  fileName: 'index.html',
};

const MODULE_ASSETS = new Map<string, StaticAsset>([
  ['/app.js', { contentType: 'text/javascript; charset=utf-8', fileName: 'app.js' }],
  ['/lib.js', { contentType: 'text/javascript; charset=utf-8', fileName: 'lib.js' }],
]);

async function respondAsset(response: ServerResponse, asset: StaticAsset): Promise<void> {
  const body = await readFile(new URL(asset.fileName, PUBLIC_DIR));
  response.writeHead(200, { 'Content-Type': asset.contentType });
  response.end(body);
}

export function createFrontendServer(): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method !== 'GET') {
      return respondJson(response, 405, { error: 'GET only' });
    }

    if (url.pathname === '/healthz') {
      return respondJson(response, 200, { status: 'ok' });
    }

    try {
      await respondAsset(response, MODULE_ASSETS.get(url.pathname) ?? INDEX_ASSET);
    } catch (error) {
      respondJson(response, 500, { error: errorMessage(error) });
    }
  });
}
