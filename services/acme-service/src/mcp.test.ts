import { describe, expect, it } from 'vitest';

import { handleMcp } from './mcp.js';
import { createProjectStore } from './store.js';
import type { McpRequest, Project, RptClaims } from './types.js';

interface RpcResultBody {
  error?: { code: number; message: string };
  id?: number | string | null;
  jsonrpc?: string;
  result?: {
    _meta?: { tenantRegion?: string };
    capabilities?: { tools?: object };
    content?: Array<{ text: string; type: string }>;
    isError?: boolean;
    protocolVersion?: string;
    serverInfo?: { name: string; version: string };
    tools?: Array<{ inputSchema: object; name: string }>;
  };
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function mintRpt(handle = 'tenant-a', overrides: Partial<RptClaims> = {}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: RptClaims = {
    aud: 'client',
    exp: nowSeconds + 300,
    permissions: [{ rsname: `acme.client:${handle}`, scopes: ['access'] }],
    sub: 'admin_a@test.com',
    ...overrides,
  };
  return `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url(claims)}.`;
}

function rpcBody(method: string, params: Record<string, unknown> = {}, id: number = 1): string {
  return JSON.stringify({ id, jsonrpc: '2.0', method, params });
}

function mcpRequest(overrides: Partial<McpRequest> = {}): McpRequest {
  return {
    authorization: `Bearer ${mintRpt()}`,
    body: rpcBody('tools/list'),
    method: 'POST',
    tenantId: 'tenant-a',
    tenantRegion: 'eu',
    ...overrides,
  };
}

function callTool(name: string, args: Record<string, unknown>): Partial<McpRequest> {
  return { body: rpcBody('tools/call', { arguments: args, name }) };
}

function toolText(body: unknown): string {
  const content = (body as RpcResultBody).result?.content;
  expect(content).toEqual([{ text: expect.any(String), type: 'text' }]);
  return content?.[0]?.text ?? '';
}

describe('handleMcp protocol', () => {
  it('answers initialize with the echoed protocol version, capabilities and serverInfo', () => {
    const response = handleMcp(
      createProjectStore(),
      mcpRequest({ body: rpcBody('initialize', { protocolVersion: '2025-03-26' }) }),
    );

    expect(response.status).toBe(200);
    const body = response.body as RpcResultBody;
    expect(body.id).toBe(1);
    expect(body.result?.protocolVersion).toBe('2025-03-26');
    expect(body.result?.capabilities).toEqual({ tools: {} });
    expect(body.result?.serverInfo?.name).toBe('acme-mcp');
  });

  it('answers notifications/initialized with an empty 202', () => {
    const response = handleMcp(
      createProjectStore(),
      mcpRequest({ body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }),
    );

    expect(response).toEqual({ body: undefined, status: 202 });
  });

  it('lists the three project tools with schemas', () => {
    const response = handleMcp(createProjectStore(), mcpRequest());

    expect(response.status).toBe(200);
    const tools = (response.body as RpcResultBody).result?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_projects',
      'get_project',
      'create_project',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('rejects GET with 405', () => {
    const response = handleMcp(createProjectStore(), mcpRequest({ method: 'GET' }));

    expect(response.status).toBe(405);
    expect(response.headers).toEqual({ Allow: 'POST' });
  });

  it('answers an unknown method with a method-not-found error', () => {
    const response = handleMcp(
      createProjectStore(),
      mcpRequest({ body: rpcBody('resources/list') }),
    );

    expect(response.status).toBe(200);
    expect((response.body as RpcResultBody).error?.code).toBe(-32601);
  });
});

describe('handleMcp tools/call', () => {
  it('creates, gets and lists projects through tool calls, echoing the region', () => {
    const store = createProjectStore();

    const created = handleMcp(
      store,
      mcpRequest(callTool('create_project', { description: 'First', name: 'Alpha' })),
    );
    expect(created.status).toBe(200);
    const project = JSON.parse(toolText(created.body)) as Project;
    expect(project).toMatchObject({ description: 'First', name: 'Alpha' });
    expect((created.body as RpcResultBody).result?._meta).toEqual({ tenantRegion: 'eu' });

    const fetched = handleMcp(store, mcpRequest(callTool('get_project', { id: project.id })));
    expect(JSON.parse(toolText(fetched.body))).toEqual(project);

    const listed = handleMcp(store, mcpRequest(callTool('list_projects', {})));
    expect(JSON.parse(toolText(listed.body))).toEqual([project]);
  });

  it('marks an unknown project id as a tool error result', () => {
    const response = handleMcp(
      createProjectStore(),
      mcpRequest(callTool('get_project', { id: 'proj-999' })),
    );

    expect(response.status).toBe(200);
    expect((response.body as RpcResultBody).result?.isError).toBe(true);
  });

  it('rejects an unknown tool with invalid params', () => {
    const response = handleMcp(createProjectStore(), mcpRequest(callTool('drop_tables', {})));

    expect(response.status).toBe(200);
    expect((response.body as RpcResultBody).error?.code).toBe(-32602);
  });
});

describe('handleMcp auth', () => {
  it('rejects a missing bearer with 401 and a WWW-Authenticate challenge', () => {
    const response = handleMcp(createProjectStore(), mcpRequest({ authorization: undefined }));

    expect(response.status).toBe(401);
    expect(response.headers).toEqual({ 'WWW-Authenticate': 'Bearer' });
  });

  it('rejects a garbled bearer with 401', () => {
    const response = handleMcp(
      createProjectStore(),
      mcpRequest({ authorization: 'Bearer not-a-jwt' }),
    );

    expect(response.status).toBe(401);
    expect(response.headers).toEqual({ 'WWW-Authenticate': 'Bearer' });
  });

  it('serves tools/list on a delegated non-RPT bearer, because schemas are tenant-independent', () => {
    const response = handleMcp(
      createProjectStore(),
      mcpRequest({ authorization: `Bearer ${mintRpt('tenant-a', { aud: 'account' })}` }),
    );

    expect(response.status).toBe(200);
    expect((response.body as RpcResultBody).result?.tools).toHaveLength(3);
  });

  it('rejects a tools/call with an expired RPT with 401', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const response = handleMcp(
      createProjectStore(),
      mcpRequest({
        ...callTool('list_projects', {}),
        authorization: `Bearer ${mintRpt('tenant-a', { exp: nowSeconds - 10 })}`,
      }),
    );

    expect(response.status).toBe(401);
  });

  it('rejects a tools/call whose bearer audience is not client with 401', () => {
    const response = handleMcp(
      createProjectStore(),
      mcpRequest({
        ...callTool('list_projects', {}),
        authorization: `Bearer ${mintRpt('tenant-a', { aud: 'account' })}`,
      }),
    );

    expect(response.status).toBe(401);
  });

  it('rejects a tools/call tenant mismatch with a 403 JSON-RPC error', () => {
    const response = handleMcp(
      createProjectStore(),
      mcpRequest({ ...callTool('list_projects', {}), tenantId: 'tenant-b' }),
    );

    expect(response.status).toBe(403);
    const body = response.body as RpcResultBody;
    expect(body.id).toBe(1);
    expect(body.error?.code).toBe(-32000);
  });

  it('rejects a tools/call without an x-tenant-id header with 403', () => {
    const response = handleMcp(
      createProjectStore(),
      mcpRequest({ ...callTool('list_projects', {}), tenantId: undefined }),
    );

    expect(response.status).toBe(403);
  });

  it('answers a malformed body with a parse error 400', () => {
    const response = handleMcp(createProjectStore(), mcpRequest({ body: 'not json' }));

    expect(response.status).toBe(400);
  });

  it('keeps tool data isolated across tenants', () => {
    const store = createProjectStore();

    handleMcp(store, mcpRequest(callTool('create_project', { description: 'Private', name: 'A' })));

    const listedAsTenantB = handleMcp(
      store,
      mcpRequest({
        authorization: `Bearer ${mintRpt('tenant-b')}`,
        tenantId: 'tenant-b',
        tenantRegion: 'us',
        ...callTool('list_projects', {}),
      }),
    );

    expect(listedAsTenantB.status).toBe(200);
    expect(JSON.parse(toolText(listedAsTenantB.body))).toEqual([]);
  });
});
