import { createFrontendServer } from './app.js';

const PORT = Number(process.env.PORT ?? 4000);

const server = createFrontendServer();

server.listen(PORT, () => {
  console.log(`main-app-frontend listening on http://localhost:${PORT}`);
});
