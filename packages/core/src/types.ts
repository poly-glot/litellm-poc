export type Region = 'eu' | 'us';

export interface FixtureUser {
  email: string;
  password: string;
  region: Region;
  tenant: string;
}
