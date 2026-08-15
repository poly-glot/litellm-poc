import type { ProjectStore } from './store.js';
import type { ProjectInput, RestRequest, RestResponse } from './types.js';

const PROJECTS_PATH = '/projects';

function parseProjectInput(body: string): ProjectInput | undefined {
  try {
    const parsed = JSON.parse(body) as Partial<ProjectInput>;
    if (typeof parsed.name !== 'string' || parsed.name === '') {
      return undefined;
    }
    if (typeof parsed.description !== 'string') {
      return undefined;
    }

    return { description: parsed.description, name: parsed.name };
  } catch {
    return undefined;
  }
}

export function handleRest(store: ProjectStore, request: RestRequest): RestResponse {
  if (!request.tenantId) {
    return { body: { error: 'Missing x-tenant-id header' }, status: 400 };
  }

  if (request.method === 'GET' && request.path === PROJECTS_PATH) {
    return { body: store.list(request.tenantId), status: 200 };
  }

  if (request.method === 'GET' && request.path.startsWith(`${PROJECTS_PATH}/`)) {
    const id = request.path.slice(PROJECTS_PATH.length + 1);
    const project = store.get(request.tenantId, id);
    return project
      ? { body: project, status: 200 }
      : { body: { error: `Unknown project ${id}` }, status: 404 };
  }

  if (request.method === 'POST' && request.path === PROJECTS_PATH) {
    const input = parseProjectInput(request.body);
    return input
      ? { body: store.create(request.tenantId, input), status: 201 }
      : { body: { error: 'Body must be {"name": string, "description": string}' }, status: 400 };
  }

  return {
    body: { error: 'Use GET /projects, GET /projects/<id> or POST /projects' },
    status: 404,
  };
}
