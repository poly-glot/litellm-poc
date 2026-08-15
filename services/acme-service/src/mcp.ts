import { authenticateBearer, authorize } from './auth.js';
import type { ProjectStore } from './store.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import type { McpRequest, McpResponse } from './types.js';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const JSON_RPC_VERSION = '2.0';
const SERVER_INFO = { name: 'acme-mcp', version: '0.1.0' };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const FORBIDDEN = -32000;

type JsonRpcId = number | string | null;

type ParsedBody =
  | { code: number; kind: 'invalid'; message: string }
  | { kind: 'notification'; method: string }
  | { id: JsonRpcId; kind: 'request'; method: string; params: Record<string, unknown> };

interface RpcRequest {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseBody(body: string): ParsedBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { code: PARSE_ERROR, kind: 'invalid', message: 'Parse error' };
  }

  const message = asRecord(parsed);
  if (!message || message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== 'string') {
    return { code: INVALID_REQUEST, kind: 'invalid', message: 'Invalid Request' };
  }

  if (!('id' in message)) {
    return { kind: 'notification', method: message.method };
  }

  const id = message.id;
  if (typeof id !== 'number' && typeof id !== 'string' && id !== null) {
    return { code: INVALID_REQUEST, kind: 'invalid', message: 'Invalid Request' };
  }

  return { id, kind: 'request', method: message.method, params: asRecord(message.params) ?? {} };
}

function resultBody(id: JsonRpcId, result: unknown): unknown {
  return { id, jsonrpc: JSON_RPC_VERSION, result };
}

function errorBody(id: JsonRpcId, code: number, message: string): unknown {
  return { error: { code, message }, id, jsonrpc: JSON_RPC_VERSION };
}

function withRegionMeta(
  result: Record<string, unknown>,
  tenantRegion: string | undefined,
): Record<string, unknown> {
  return tenantRegion ? { ...result, _meta: { tenantRegion } } : result;
}

function handleToolCall(
  store: ProjectStore,
  tenantId: string,
  tenantRegion: string | undefined,
  request: RpcRequest,
): McpResponse {
  const name = request.params.name;
  if (typeof name !== 'string') {
    return {
      body: errorBody(request.id, INVALID_PARAMS, 'tools/call requires params.name'),
      status: 200,
    };
  }

  const outcome = executeTool(store, tenantId, name, asRecord(request.params.arguments) ?? {});
  if (outcome.kind === 'unknown-tool' || outcome.kind === 'invalid-params') {
    return { body: errorBody(request.id, INVALID_PARAMS, outcome.message), status: 200 };
  }

  const result =
    outcome.kind === 'tool-error'
      ? {
          content: [{ text: JSON.stringify({ error: outcome.message }), type: 'text' }],
          isError: true,
        }
      : { content: [{ text: JSON.stringify(outcome.value), type: 'text' }] };

  return { body: resultBody(request.id, withRegionMeta(result, tenantRegion)), status: 200 };
}

function dispatch(
  store: ProjectStore,
  tenantId: string,
  tenantRegion: string | undefined,
  request: RpcRequest,
): McpResponse {
  if (request.method === 'initialize') {
    const clientVersion = request.params.protocolVersion;
    const result = {
      capabilities: { tools: {} },
      protocolVersion: typeof clientVersion === 'string' ? clientVersion : DEFAULT_PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
    };
    return { body: resultBody(request.id, withRegionMeta(result, tenantRegion)), status: 200 };
  }

  if (request.method === 'tools/list') {
    return {
      body: resultBody(request.id, withRegionMeta({ tools: TOOL_DEFINITIONS }, tenantRegion)),
      status: 200,
    };
  }

  if (request.method === 'tools/call') {
    return handleToolCall(store, tenantId, tenantRegion, request);
  }

  return {
    body: errorBody(request.id, METHOD_NOT_FOUND, `Method not found: ${request.method}`),
    status: 200,
  };
}

export function handleMcp(store: ProjectStore, request: McpRequest): McpResponse {
  if (request.method !== 'POST') {
    return { body: { error: 'Use POST /mcp' }, headers: { Allow: 'POST' }, status: 405 };
  }

  const bearer = authenticateBearer(request.authorization);
  if (bearer.kind === 'unauthorized') {
    return {
      body: { error: bearer.reason },
      headers: { 'WWW-Authenticate': 'Bearer' },
      status: 401,
    };
  }

  const parsed = parseBody(request.body);

  if (parsed.kind === 'invalid') {
    return { body: errorBody(null, parsed.code, parsed.message), status: 400 };
  }

  if (parsed.kind === 'notification') {
    return { body: undefined, status: 202 };
  }

  if (parsed.method !== 'tools/call') {
    return dispatch(store, '', request.tenantRegion, parsed);
  }

  const auth = authorize(request.authorization, request.tenantId, Math.floor(Date.now() / 1000));
  if (auth.kind === 'unauthorized') {
    return {
      body: { error: auth.reason },
      headers: { 'WWW-Authenticate': 'Bearer' },
      status: 401,
    };
  }

  if (auth.kind === 'forbidden') {
    return { body: errorBody(parsed.id, FORBIDDEN, auth.reason), status: 403 };
  }

  return dispatch(store, auth.tenantId, request.tenantRegion, parsed);
}
