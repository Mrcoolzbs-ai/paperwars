import Fastify, { type FastifyInstance } from 'fastify';
import { createSimulationEngine } from '@paper-wars/simulation';

export interface CreateAppOptions {
  readonly logger?: boolean;
  readonly rulesetVersion?: string;
  readonly rngVersion?: string;
}

/** Creates an API instance without opening a socket or starting background work. */
export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const engine = createSimulationEngine({
    rulesetVersion: options.rulesetVersion ?? 'baseline-pending-import',
    rngVersion: options.rngVersion ?? 'rng-pending-import',
  });

  app.get('/health', async () => ({
    status: 'ok',
    engineVersion: engine.engineVersion,
    rulesetVersion: engine.rulesetVersion,
    rngVersion: engine.rngVersion,
  }));

  return app;
}
