import type { ProjectStore } from './store.js';
import type { ToolOutcome } from './types.js';

export const TOOL_DEFINITIONS = [
  {
    description: 'List the projects visible to the calling tenant',
    inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
    name: 'list_projects',
  },
  {
    description: 'Fetch one project by id',
    inputSchema: {
      additionalProperties: false,
      properties: { id: { type: 'string' } },
      required: ['id'],
      type: 'object',
    },
    name: 'get_project',
  },
  {
    description: 'Create a project with a name and a description',
    inputSchema: {
      additionalProperties: false,
      properties: { description: { type: 'string' }, name: { type: 'string' } },
      required: ['description', 'name'],
      type: 'object',
    },
    name: 'create_project',
  },
] as const;

export function executeTool(
  store: ProjectStore,
  tenantId: string,
  name: string,
  args: Record<string, unknown>,
): ToolOutcome {
  if (name === 'list_projects') {
    return { kind: 'result', value: store.list(tenantId) };
  }

  if (name === 'get_project') {
    if (typeof args.id !== 'string' || args.id === '') {
      return { kind: 'invalid-params', message: 'get_project requires {"id": string}' };
    }

    const project = store.get(tenantId, args.id);
    return project
      ? { kind: 'result', value: project }
      : { kind: 'tool-error', message: `Unknown project ${args.id}` };
  }

  if (name === 'create_project') {
    if (typeof args.name !== 'string' || args.name === '' || typeof args.description !== 'string') {
      return {
        kind: 'invalid-params',
        message: 'create_project requires {"name": string, "description": string}',
      };
    }

    return {
      kind: 'result',
      value: store.create(tenantId, { description: args.description, name: args.name }),
    };
  }

  return { kind: 'unknown-tool', message: `Unknown tool ${name}` };
}
