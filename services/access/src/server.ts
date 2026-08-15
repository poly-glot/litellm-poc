import { createAccessServer } from './app.js';

const PORT = Number(process.env.PORT ?? 4014);
const ISSUER_ALLOWLIST_PREFIX = process.env.ISSUER_ALLOWLIST_PREFIX ?? 'http://localhost:4018';

const server = createAccessServer({
  issuerAllowlistPrefix: ISSUER_ALLOWLIST_PREFIX,
  rptIssuer: `http://localhost:${PORT}`,
});

server.listen(PORT, () => {
  console.log(`access listening on http://localhost:${PORT}`);
});
