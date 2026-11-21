import { describe, expect, it } from 'vitest';
import {
  assertRulesetCompatible,
  assertSnapshotCompatible,
  assertTurnResolutionMatchesInput,
  RulesetCompatibilityError,
  TurnResolutionInvariantError,
  type RulesetManifest,
  type TurnResolution,
  type WorldSnapshot,
} from '@paper-wars/domain';
import { toId, toTurnNumber } from '@paper-wars/shared';

const manifest: RulesetManifest = {
  rulesetVersion: 'baseline-v1',
  rngVersion: 'rng-v1',
  worldStateSchemaVersion: 1,
  supportedEngineVersions: ['0.1.0', '0.2.0'],
};

const engine = {
  engineVersion: '0.1.0',
  rulesetVersion: 'baseline-v1',
  rngVersion: 'rng-v1',
};

const snapshot: WorldSnapshot<{ readonly value: number }> = {
  campaignId: toId<'CampaignId'>('campaign-1'),
  turnNumber: toTurnNumber(1),
  version: 1,
  stateSchemaVersion: 1,
  rulesetVersion: 'baseline-v1',
  state: { value: 10 },
};

describe('versioned ruleset compatibility', () => {
  it('accepts a supported engine and matching snapshot schema', () => {
    expect(() => assertRulesetCompatible(manifest, engine)).not.toThrow();
    expect(() => assertSnapshotCompatible(snapshot, manifest)).not.toThrow();
  });

  it('rejects wrong ruleset, RNG or engine versions', () => {
    expect(() =>
      assertRulesetCompatible(manifest, { ...engine, rulesetVersion: 'baseline-v2' }),
    ).toThrow(RulesetCompatibilityError);
    expect(() => assertRulesetCompatible(manifest, { ...engine, rngVersion: 'rng-v2' })).toThrow(
      RulesetCompatibilityError,
    );
    expect(() => assertRulesetCompatible(manifest, { ...engine, engineVersion: '9.9.9' })).toThrow(
      RulesetCompatibilityError,
    );
  });

  it('rejects empty/duplicate engine support and non-positive state schema versions', () => {
    expect(() =>
      assertRulesetCompatible({ ...manifest, supportedEngineVersions: [] }, engine),
    ).toThrow(RulesetCompatibilityError);
    expect(() =>
      assertRulesetCompatible({ ...manifest, supportedEngineVersions: ['0.1.0', '0.1.0'] }, engine),
    ).toThrow(RulesetCompatibilityError);
    expect(() =>
      assertRulesetCompatible({ ...manifest, worldStateSchemaVersion: 0 }, engine),
    ).toThrow(RulesetCompatibilityError);
  });

  it('rejects snapshots created with a different ruleset or state schema version', () => {
    expect(() =>
      assertSnapshotCompatible({ ...snapshot, rulesetVersion: 'baseline-v2' }, manifest),
    ).toThrow(RulesetCompatibilityError);
    expect(() =>
      assertSnapshotCompatible({ ...snapshot, stateSchemaVersion: 2 }, manifest),
    ).toThrow(RulesetCompatibilityError);
    expect(() => assertSnapshotCompatible({ ...snapshot, version: 0 }, manifest)).toThrow(
      RulesetCompatibilityError,
    );
  });
});

describe('turn-resolution contracts', () => {
  const resolution: TurnResolution<{ readonly value: number }> = {
    campaignId: snapshot.campaignId,
    turnNumber: snapshot.turnNumber,
    sourceSnapshotVersion: snapshot.version,
    nextState: { value: 12 },
    orderResults: [
      {
        orderId: toId<'OrderId'>('order-1'),
        status: 'accepted',
        resultCode: 'BUILD_QUEUED',
      },
    ],
    events: [],
    randomDraws: [
      {
        domain: 'economy',
        drawId: 'tax:country-1',
        minValue: 1,
        maxValue: 100,
        value: 74,
      },
    ],
    campaignEnded: false,
  };

  it('accepts a matching resolution and in-range deterministic draw log', () => {
    expect(() => assertTurnResolutionMatchesInput(snapshot, resolution)).not.toThrow();
  });

  it('rejects a wrong campaign, turn or stale source snapshot', () => {
    expect(() =>
      assertTurnResolutionMatchesInput(snapshot, {
        ...resolution,
        campaignId: toId<'CampaignId'>('campaign-2'),
      }),
    ).toThrow(TurnResolutionInvariantError);
    expect(() =>
      assertTurnResolutionMatchesInput(snapshot, {
        ...resolution,
        turnNumber: toTurnNumber(2),
      }),
    ).toThrow(TurnResolutionInvariantError);
    expect(() =>
      assertTurnResolutionMatchesInput(snapshot, {
        ...resolution,
        sourceSnapshotVersion: 2,
      }),
    ).toThrow(TurnResolutionInvariantError);
  });

  it('rejects invalid or duplicate random draw records and duplicate order results', () => {
    expect(() =>
      assertTurnResolutionMatchesInput(snapshot, {
        ...resolution,
        randomDraws: [{ ...resolution.randomDraws[0]!, value: 101 }],
      }),
    ).toThrow(TurnResolutionInvariantError);
    expect(() =>
      assertTurnResolutionMatchesInput(snapshot, {
        ...resolution,
        randomDraws: [...resolution.randomDraws, resolution.randomDraws[0]!],
      }),
    ).toThrow(TurnResolutionInvariantError);
    expect(() =>
      assertTurnResolutionMatchesInput(snapshot, {
        ...resolution,
        orderResults: [...resolution.orderResults, resolution.orderResults[0]!],
      }),
    ).toThrow(TurnResolutionInvariantError);
  });
});
