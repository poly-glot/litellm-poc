import { describe, expect, it } from 'vitest';

import { handleRest } from './rest.js';
import { createProjectStore } from './store.js';
import type { Project, RestRequest } from './types.js';

function request(overrides: Partial<RestRequest>): RestRequest {
  return { body: '', method: 'GET', path: '/projects', tenantId: 'tenant-a', ...overrides };
}

describe('handleRest', () => {
  it('rejects a request without a tenant header with 400', () => {
    const result = handleRest(createProjectStore(), request({ tenantId: undefined }));

    expect(result.status).toBe(400);
  });

  it('creates, gets and lists a project for one tenant', () => {
    const store = createProjectStore();

    const created = handleRest(
      store,
      request({ body: JSON.stringify({ description: 'First', name: 'Alpha' }), method: 'POST' }),
    );
    expect(created.status).toBe(201);

    const project = created.body as Project;
    expect(project.id).toMatch(/^proj-\d+$/);
    expect(project).toMatchObject({ description: 'First', name: 'Alpha' });

    expect(handleRest(store, request({ path: `/projects/${project.id}` }))).toEqual({
      body: project,
      status: 200,
    });
    expect(handleRest(store, request({}))).toEqual({ body: [project], status: 200 });
  });

  it('returns 404 for an unknown project id', () => {
    const result = handleRest(createProjectStore(), request({ path: '/projects/proj-999' }));

    expect(result.status).toBe(404);
  });

  it('rejects a create without a name with 400', () => {
    const result = handleRest(
      createProjectStore(),
      request({ body: JSON.stringify({ description: 'No name' }), method: 'POST' }),
    );

    expect(result.status).toBe(400);
  });

  it('rejects a create with a malformed body with 400', () => {
    const result = handleRest(createProjectStore(), request({ body: 'not json', method: 'POST' }));

    expect(result.status).toBe(400);
  });

  it('hides projects created under tenant-a from tenant-b', () => {
    const store = createProjectStore();

    const created = handleRest(
      store,
      request({ body: JSON.stringify({ description: 'Private', name: 'Alpha' }), method: 'POST' }),
    );
    const project = created.body as Project;

    expect(handleRest(store, request({ tenantId: 'tenant-b' }))).toEqual({ body: [], status: 200 });
    expect(
      handleRest(store, request({ path: `/projects/${project.id}`, tenantId: 'tenant-b' })).status,
    ).toBe(404);
  });

  it('returns 404 for an unknown route', () => {
    const result = handleRest(createProjectStore(), request({ path: '/pets' }));

    expect(result.status).toBe(404);
  });
});
