import { createGateway, type Gateway } from './index.js';
import { createApp } from '../api/rest/index.js';
import { createLogger } from '../security/logger.js';
import type { FastifyInstance } from 'fastify';

const logger = createLogger();
let gateway: Gateway | undefined;
let app: FastifyInstance | undefined;
let closing: Promise<void> | undefined;
const shutdown = (): Promise<void> => closing ??= (async () => {
  gateway?.beginShutdown();
  try { await app?.close(); }
  finally { await gateway?.stop(); }
})();

try {
  gateway = await createGateway({ deferReady: true });
  app = await createApp(gateway);
  const address = await app.listen({ port: gateway.config.port, host: gateway.config.host });
  gateway.markReady();
  gateway.logger.info({ address }, 'gateway ready');
  const handleSignal = () => { void shutdown().catch(() => {
    logger.error({ errorCategory: 'shutdown' }, 'Gateway shutdown failed');
    process.exitCode = 1;
  }); };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
} catch {
  logger.error({ errorCategory: 'startup' }, 'Gateway startup failed');
  await shutdown().catch(() => {});
  process.exitCode = 1;
}
