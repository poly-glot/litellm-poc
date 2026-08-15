import { createMainAppServer } from './app.js';

const PORT = Number(process.env.PORT ?? 4004);

const server = createMainAppServer({
  apiKey: process.env.LITELLM_MASTER_KEY ?? 'sk-litellm-dev',
  gatewayUrl: process.env.GATEWAY_URL ?? 'http://litellm:4000',
  model: process.env.CHAT_MODEL ?? 'qwen3-local',
});

server.listen(PORT, () => {
  console.log(`main-app listening on http://localhost:${PORT}`);
});
