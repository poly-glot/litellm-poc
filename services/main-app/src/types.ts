export interface AppConfig {
  apiKey: string;
  gatewayUrl: string;
  model: string;
}

export interface ChatMessage {
  content: string;
  role: 'assistant' | 'system' | 'user';
}

export interface ChatMetadata {
  tags: string[];
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  metadata: ChatMetadata;
  model: string;
}

export interface ChatChoice {
  message: {
    content: string | null;
  };
}

export interface ChatCompletionResponse {
  choices: ChatChoice[];
  model: string;
}

export interface GatewayChatInput {
  prompt: string;
  tenant: string;
}

export type GatewayResult =
  { completion: ChatCompletionResponse; ok: true } | { error: string; ok: false; status: number };
