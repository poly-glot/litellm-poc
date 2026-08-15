export type AuthOutcome =
  | { kind: 'authorized'; tenantId: string }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'unauthorized'; reason: string };

export type BearerOutcome = { kind: 'bearer-present' } | { kind: 'unauthorized'; reason: string };

export interface McpRequest {
  authorization: string | undefined;
  body: string;
  method: string;
  tenantId: string | undefined;
  tenantRegion: string | undefined;
}

export interface McpResponse {
  body: unknown;
  headers?: Record<string, string>;
  status: number;
}

export interface ProtectedResourceMetadata {
  authorization_servers: string[];
  bearer_methods_supported: string[];
  resource: string;
}

export interface Project {
  description: string;
  id: string;
  name: string;
}

export interface ProjectInput {
  description: string;
  name: string;
}

export interface RestRequest {
  body: string;
  method: string;
  path: string;
  tenantId: string | undefined;
}

export interface RestResponse {
  body: unknown;
  status: number;
}

export interface RptClaims {
  aud?: string | string[];
  exp?: number;
  permissions?: Array<RptPermission | string>;
  sub?: string;
}

export interface RptPermission {
  rsname?: string;
  scopes?: string[];
}

export type ToolOutcome =
  | { kind: 'invalid-params'; message: string }
  | { kind: 'result'; value: unknown }
  | { kind: 'tool-error'; message: string }
  | { kind: 'unknown-tool'; message: string };
