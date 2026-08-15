import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  GatewayChatInput,
  GatewayResult,
} from './types.js';

const SERVICE_TAG = 'agent:main-app';

export function parseChatInput(body: string): GatewayChatInput | null {
  try {
    const { prompt, tenant } = JSON.parse(body) as Partial<GatewayChatInput>;

    if (typeof prompt !== 'string' || prompt.length === 0) {
      return null;
    }

    if (typeof tenant !== 'string' || tenant.length === 0) {
      return null;
    }

    return { prompt, tenant };
  } catch {
    return null;
  }
}

export function buildChatRequest(input: GatewayChatInput, model: string): ChatCompletionRequest {
  return {
    messages: [{ content: input.prompt, role: 'user' }],
    metadata: { tags: [SERVICE_TAG, `tenant:${input.tenant}`] },
    model,
  };
}

export function extractReply(response: ChatCompletionResponse): string {
  return response.choices[0]?.message.content ?? '';
}

export async function sendChat(
  baseUrl: string,
  apiKey: string,
  request: ChatCompletionRequest,
): Promise<GatewayResult> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify(request),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  const text = await response.text();

  if (!response.ok) {
    return { error: text, ok: false, status: response.status };
  }

  return { completion: JSON.parse(text) as ChatCompletionResponse, ok: true };
}
