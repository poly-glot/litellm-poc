import { describe, expect, it } from 'vitest';

import { createProjectStore, seedExampleProjects } from './store.js';

describe('createProjectStore', () => {
  it('creates a project with a generated id and finds it again', () => {
    const store = createProjectStore();

    const created = store.create('tenant-a', { description: 'First', name: 'Alpha' });

    expect(created.id).toMatch(/^proj-\d+$/);
    expect(store.get('tenant-a', created.id)).toEqual(created);
  });

  it('lists projects in creation order', () => {
    const store = createProjectStore();

    const first = store.create('tenant-a', { description: 'First', name: 'Alpha' });
    const second = store.create('tenant-a', { description: 'Second', name: 'Beta' });

    expect(store.list('tenant-a')).toEqual([first, second]);
  });

  it('keeps tenants isolated', () => {
    const store = createProjectStore();

    const created = store.create('tenant-a', { description: 'Private', name: 'Alpha' });

    expect(store.list('tenant-b')).toEqual([]);
    expect(store.get('tenant-b', created.id)).toBeUndefined();
  });

  it('returns undefined for an unknown id', () => {
    const store = createProjectStore();

    expect(store.get('tenant-a', 'proj-999')).toBeUndefined();
  });
});

describe('seedExampleProjects', () => {
  it('seeds one project for tenant-a only', () => {
    const store = createProjectStore();

    seedExampleProjects(store);

    expect(store.list('tenant-a')).toHaveLength(1);
    expect(store.list('tenant-b')).toEqual([]);
  });
});
