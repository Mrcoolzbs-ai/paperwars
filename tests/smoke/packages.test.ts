import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '@paper-wars/api';
import type { DomainEventEnvelope } from '@paper-wars/domain';
import type { ReadRepository } from '@paper-wars/persistence';
import { createCoordinates, coordinatesKey, toId, toTurnNumber } from '@paper-wars/shared';
import { createSimulationEngine } from '@paper-wars/simulation';

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Stage 1.1 package smoke tests', () => {
  it('exports shared runtime utilities and validates primitives', () => {
    expect(coordinatesKey(createCoordinates(3, 7))).toBe('3:7');
    expect(toId<'CampaignId'>('campaign-1')).toBe('campaign-1');
    expect(toTurnNumber(1)).toBe(1);
    expect(() => toTurnNumber(0)).toThrow(RangeError);
  });

  it('exposes domain and persistence contracts to consumers', () => {
    const event: DomainEventEnvelope<'test.event', { readonly value: number }> = {
      eventId: toId<'EventId'>('event-1'),
      campaignId: toId<'CampaignId'>('campaign-1'),
      turnNumber: toTurnNumber(1),
      type: 'test.event',
      schemaVersion: 1,
      payload: { value: 7 },
      visibility: 'public',
    };
    const repository: ReadRepository<string, string> = {
      async findById(id) {
        return id === 'known' ? 'found' : null;
      },
    };
    expect(event.payload.value).toBe(7);
    expect(repository.findById).toBeTypeOf('function');
  });

  it('creates the simulation engine through its public package entry', () => {
    const engine = createSimulationEngine({ rulesetVersion: 'pending', rngVersion: 'pending' });
    expect(engine.engineVersion).toBe('0.1.0');
    expect(Object.isFrozen(engine)).toBe(true);
  });

  it('imports the API without starting a server and serves health via injection', async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', engineVersion: '0.1.0' });
  });
});
