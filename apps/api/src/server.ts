import { createApp } from './app.js';

const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new RangeError(`Invalid PORT value: ${process.env['PORT'] ?? ''}`);
}

const app = createApp({ logger: true });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}

const shutdown = async (): Promise<void> => {
  await app.close();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
