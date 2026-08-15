import { TENANT_REGIONS } from '@litellm-poc/core';

import { createAcmeServer } from './app.js';
import { createProjectStore, seedExampleProjects } from './store.js';

const PORT = Number(process.env.PORT ?? 4022);
const IDENTITY_PUBLIC_BASE = process.env.IDENTITY_PUBLIC_BASE ?? 'http://localhost:4018';
const GATEWAY_PUBLIC_RESOURCE = process.env.GATEWAY_PUBLIC_RESOURCE ?? 'http://localhost:4010/';

const regions = [...new Set(TENANT_REGIONS.values())];

const store = createProjectStore();
seedExampleProjects(store);

createAcmeServer(store, {
  authorization_servers: regions.map((region) => `${IDENTITY_PUBLIC_BASE}/${region}/realms/acme`),
  bearer_methods_supported: ['header'],
  resource: GATEWAY_PUBLIC_RESOURCE,
}).listen(PORT, () => {
  console.log(`acme-service listening on http://localhost:${PORT}`);
});
