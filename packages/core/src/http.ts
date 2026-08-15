import type { ServerResponse } from 'node:http';

export const CORS_ALLOW_ALL_ORIGIN = { 'Access-Control-Allow-Origin': '*' } as const;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function respondCorsPreflight(response: ServerResponse): void {
  response.writeHead(204, {
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST',
    ...CORS_ALLOW_ALL_ORIGIN,
  });
  response.end();
}

export function respondJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}
