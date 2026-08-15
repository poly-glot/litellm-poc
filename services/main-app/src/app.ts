import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import type { Server } from 'node:http';

import { errorMessage, respondJson } from '@litellm-poc/core';

import { buildChatRequest, extractReply, parseChatInput, sendChat } from './chat.js';
import type { AppConfig } from './types.js';

export function createMainAppServer(config: AppConfig): Server {
  return createServer(async (request, response) => {
    switch (`${request.method} ${request.url}`) {
      case 'GET /healthz':
        return respondJson(response, 200, { status: 'ok' });

      case 'POST /chat': {
        const input = parseChatInput(await text(request));
        if (input === null) {
          return respondJson(response, 400, {
            error: 'Body must be JSON with non-empty prompt and tenant',
          });
        }

        try {
          const chatRequest = buildChatRequest(input, config.model);
          const result = await sendChat(config.gatewayUrl, config.apiKey, chatRequest);

          if (!result.ok) {
            return respondJson(response, result.status, { error: result.error });
          }

          return respondJson(response, 200, { reply: extractReply(result.completion) });
        } catch (error) {
          return respondJson(response, 502, { error: errorMessage(error) });
        }
      }

      default:
        return respondJson(response, 404, { error: 'Use GET /healthz or POST /chat' });
    }
  });
}
