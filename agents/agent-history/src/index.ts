import { createServer, envInt } from './server.ts';
const port = envInt('PORT', process.env.PORT, 9091), host = process.env.HOST ?? '0.0.0.0';
createServer().listen(port, host, () => console.log(`[agent-history] listening on ${host}:${port}`));
