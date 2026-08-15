import { FIXTURE_USERS } from '@litellm-poc/core';

import type { Project, ProjectInput } from './types.js';

export interface ProjectStore {
  create(tenantId: string, input: ProjectInput): Project;
  get(tenantId: string, id: string): Project | undefined;
  list(tenantId: string): Project[];
}

export function createProjectStore(): ProjectStore {
  const projectsByTenant = new Map<string, Map<string, Project>>();
  let sequence = 0;

  function tenantProjects(tenantId: string): Map<string, Project> {
    const existing = projectsByTenant.get(tenantId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, Project>();
    projectsByTenant.set(tenantId, created);
    return created;
  }

  return {
    create(tenantId, input) {
      sequence += 1;
      const project: Project = {
        description: input.description,
        id: `proj-${sequence}`,
        name: input.name,
      };
      tenantProjects(tenantId).set(project.id, project);
      return project;
    },
    get(tenantId, id) {
      return projectsByTenant.get(tenantId)?.get(id);
    },
    list(tenantId) {
      return [...(projectsByTenant.get(tenantId)?.values() ?? [])];
    },
  };
}

export function seedExampleProjects(store: ProjectStore): void {
  const [{ tenant }] = FIXTURE_USERS;

  store.create(tenant, {
    description: `Seeded example project so ${tenant} lists are non-empty out of the box`,
    name: 'Example Project',
  });
}
