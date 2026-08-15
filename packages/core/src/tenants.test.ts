import { describe, expect, it } from 'vitest';

import { ENTITLEMENTS, FIXTURE_USERS, TENANT_REGIONS } from './tenants.js';

describe('tenant fixture', () => {
  it('entitles every fixture user to exactly their own tenant', () => {
    expect(ENTITLEMENTS.size).toBe(FIXTURE_USERS.length);
    for (const user of FIXTURE_USERS) {
      expect(ENTITLEMENTS.get(user.email)).toBe(user.tenant);
    }
  });

  it('maps every entitled tenant to its region', () => {
    expect(TENANT_REGIONS.size).toBe(FIXTURE_USERS.length);
    for (const user of FIXTURE_USERS) {
      expect(TENANT_REGIONS.get(user.tenant)).toBe(user.region);
    }
  });

  it('keeps the demo trio stable for the e2e walk-through', () => {
    expect(ENTITLEMENTS.get('admin_a@test.com')).toBe('tenant-a');
    expect(TENANT_REGIONS.get('tenant-a')).toBe('eu');
    expect(TENANT_REGIONS.get('tenant-b')).toBe('us');
  });
});
