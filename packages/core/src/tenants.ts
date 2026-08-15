import type { FixtureUser, Region } from './types.js';

export const FIXTURE_USERS = [
  { email: 'admin_a@test.com', password: '123456', region: 'eu', tenant: 'tenant-a' },
  { email: 'admin_b@test.com', password: '123456', region: 'us', tenant: 'tenant-b' },
  { email: 'admin_c@test.com', password: '123456', region: 'eu', tenant: 'tenant-c' },
  { email: 'admin_d@test.com', password: '123456', region: 'us', tenant: 'tenant-d' },
  { email: 'admin_e@test.com', password: '123456', region: 'eu', tenant: 'tenant-e' },
] as const satisfies readonly FixtureUser[];

export const ENTITLEMENTS: ReadonlyMap<string, string> = new Map(
  FIXTURE_USERS.map((user) => [user.email, user.tenant]),
);

export const TENANT_REGIONS: ReadonlyMap<string, Region> = new Map(
  FIXTURE_USERS.map((user) => [user.tenant, user.region]),
);
