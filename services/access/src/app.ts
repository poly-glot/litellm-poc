import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import type { Server, ServerResponse } from 'node:http';

import {
  CORS_ALLOW_ALL_ORIGIN,
  ENTITLEMENTS,
  respondCorsPreflight,
  respondJson,
} from '@litellm-poc/core';

import { createRptSigner } from './rpt.js';
import { exchangeToken } from './token.js';
import type { AccessServerConfig, ExchangeDeps } from './types.js';

function respondCorsJson(response: ServerResponse, status: number, payload: unknown): void {
  respondJson(response, status, payload, CORS_ALLOW_ALL_ORIGIN);
}

export function createAccessServer(config: AccessServerConfig): Server {
  const signer = createRptSigner(config.rptIssuer);
  const deps: ExchangeDeps = {
    entitlements: ENTITLEMENTS,
    issuerAllowlistPrefix: config.issuerAllowlistPrefix,
    mintRpt: signer.mint,
  };

  return createServer(async (request, response) => {
    const { headers, method, url } = request;

    if (method === 'OPTIONS') {
      return respondCorsPreflight(response);
    }

    switch (`${method} ${url}`) {
      case 'GET /healthz':
        return respondCorsJson(response, 200, { status: 'ok' });

      case 'GET /.well-known/jwks.json':
        return respondCorsJson(response, 200, signer.jwks);

      case 'POST /token': {
        const result = await exchangeToken(deps, headers.authorization, await text(request));
        return respondCorsJson(response, result.status, result.body);
      }

      default:
        return respondCorsJson(response, 404, {
          error: 'Use GET /healthz, GET /.well-known/jwks.json or POST /token',
        });
    }
  });
}
