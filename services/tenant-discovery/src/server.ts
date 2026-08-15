import { createDiscoveryServer } from './discovery.js';

const PORT = Number(process.env.PORT ?? 4008);

createDiscoveryServer().listen(PORT, () => {
  console.log(`tenant-discovery listening on http://localhost:${PORT}`);
});
