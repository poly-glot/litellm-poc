import { FIXTURE_USERS } from '@litellm-poc/core';

import type { FixtureUser } from './types.js';

const USERS_BY_EMAIL = new Map<string, FixtureUser>(
  FIXTURE_USERS.map((user) => [user.email, user]),
);

export function authenticate(email: string, password: string): FixtureUser | undefined {
  const user = USERS_BY_EMAIL.get(email);
  return user && user.password === password ? user : undefined;
}
