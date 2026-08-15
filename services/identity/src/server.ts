import { createIdentityServer } from './app.js';

const PORT = Number(process.env.PORT ?? 4018);

const server = createIdentityServer();

server.listen(PORT, () => {
  console.log(`identity listening on http://localhost:${PORT}`);
});
