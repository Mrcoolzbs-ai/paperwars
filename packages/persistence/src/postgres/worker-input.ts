import {
  assertSnapshotCompatible,
  validateRulesetManifest,
  type OrderEnvelope,
  type RulesetManifest,
  type WorldSnapshot,
} from '@paper-wars/domain';
import { toId, toTurnNumber } from '@paper-wars/shared';
import type { Pool } from 'pg';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { loadSeedForWorker } from './seeds.js';
import { StaleWorkerError, TurnProcessingError, type TurnJobClaim } from './turn-processing.js';

export interface LoadedTurnJobInput<TState extends Record<string, unknown>, TPayload extends Record<string, unknown>, TRuleset extends RulesetManifest> {
  readonly snapshot: WorldSnapshot<TState>;
  readonly orders: readonly OrderEnvelope<TPayload>[];
  readonly ruleset: Readonly<TRuleset>;
  /** Verified plaintext for this turn only; never log or persist it. */
  readonly turnSeed: Buffer;
}
export interface LoadTurnJobInputOptions<TRuleset extends RulesetManifest> {
  readonly pool: Pool;
  readonly claim: TurnJobClaim;
  readonly keyProvider: SeedKeyProvider;
  readonly loadRuleset: (rulesetVersion: string) => Promise<TRuleset> | TRuleset;
}
interface WorkerInputRow {
  readonly campaign_id: string;
  readonly turn_number: number;
  readonly snapshot_version: number | null;
  readonly job_snapshot_version: number;
  readonly job_status: string;
  readonly generation: number;
  readonly worker_id: string | null;
  readonly lease_live: boolean;
  readonly campaign_status: string;
  readonly current_turn: number;
  readonly orders_locked: boolean;
  readonly ruleset_version: string;
  readonly rng_version: string;
  readonly snapshot_ruleset_version: string | null;
  readonly state_schema_version: number | null;
  readonly snapshot_state: unknown;
}
interface FinalizedOrderRow {
  readonly id: string;
  readonly country_id: string;
  readonly turn_number: number;
  readonly order_type: string;
  readonly schema_version: number;
  readonly status: string;
  readonly payload: unknown;
}
function asJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TurnProcessingError(label + ' must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Loads campaign, snapshot, finalized orders and verified committed seed from one DB view. */
export async function loadTurnJobInput<TState extends Record<string, unknown>, TPayload extends Record<string, unknown>, TRuleset extends RulesetManifest>(
  options: LoadTurnJobInputOptions<TRuleset>,
): Promise<LoadedTurnJobInput<TState, TPayload, TRuleset>> {
  const { pool, claim, keyProvider, loadRuleset } = options;
  const tx = await pool.connect();
  let active = false;
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    active = true;
    const sourceResult = await tx.query<WorkerInputRow>(
      'SELECT job.campaign_id, job.turn_number, job.snapshot_version AS job_snapshot_version, ' +
        'job.status AS job_status, job.generation, job.worker_id, ' +
        'COALESCE(job.lease_until > clock_timestamp(), FALSE) AS lease_live, ' +
        'campaign.status AS campaign_status, campaign.current_turn, campaign.orders_locked, ' +
        'campaign.ruleset_version, campaign.rng_version, snapshot.version AS snapshot_version, ' +
        'snapshot.ruleset_version AS snapshot_ruleset_version, snapshot.state_schema_version, ' +
        'snapshot.state AS snapshot_state FROM turn_jobs AS job ' +
        'JOIN campaigns AS campaign ON campaign.id = job.campaign_id ' +
        'LEFT JOIN world_snapshots AS snapshot ON snapshot.campaign_id = job.campaign_id ' +
        'AND snapshot.turn_number = job.turn_number WHERE job.id = $1',
      [claim.id],
    );
    const row = sourceResult.rows[0];
    if (
      !row || row.campaign_id !== claim.campaignId || row.turn_number !== claim.turnNumber ||
      row.job_snapshot_version !== claim.snapshotVersion || row.job_status !== 'processing' ||
      row.worker_id !== claim.workerId || row.generation !== claim.generation || row.lease_live !== true
    ) {
      throw new StaleWorkerError(claim.id);
    }
    if (row.campaign_status !== 'active' || row.current_turn !== claim.turnNumber || !row.orders_locked) {
      throw new TurnProcessingError('Claimed turn is not the active locked campaign turn');
    }
    if (
      row.snapshot_version !== claim.snapshotVersion || row.snapshot_state === null ||
      row.snapshot_state === undefined || row.snapshot_ruleset_version === null ||
      row.state_schema_version === null || row.snapshot_ruleset_version !== row.ruleset_version
    ) {
      throw new TurnProcessingError('Claimed source snapshot is missing or inconsistent');
    }

    const snapshot: WorldSnapshot<TState> = Object.freeze({
      campaignId: toId<'CampaignId'>(row.campaign_id),
      turnNumber: toTurnNumber(row.turn_number),
      version: row.snapshot_version,
      stateSchemaVersion: row.state_schema_version,
      rulesetVersion: row.snapshot_ruleset_version,
      state: Object.freeze(asJsonRecord(row.snapshot_state, 'Snapshot state')) as TState,
    });
    const ruleset = await loadRuleset(row.ruleset_version);
    validateRulesetManifest(ruleset);
    if (ruleset.rulesetVersion !== row.ruleset_version || ruleset.rngVersion !== row.rng_version) {
      throw new TurnProcessingError('Loaded ruleset does not match campaign ruleset/RNG versions');
    }
    assertSnapshotCompatible(snapshot, ruleset);

    const ordersResult = await tx.query<FinalizedOrderRow>(
      "SELECT id, country_id, turn_number, order_type, schema_version, status, payload " +
        "FROM orders WHERE campaign_id = $1 AND turn_number = $2 AND status = 'finalized' " +
        'ORDER BY created_at, id',
      [claim.campaignId, claim.turnNumber],
    );
    const orders: readonly OrderEnvelope<TPayload>[] = Object.freeze(
      ordersResult.rows.map((order) => {
        if (order.status !== 'finalized' || order.turn_number !== claim.turnNumber) {
          throw new TurnProcessingError('Worker input contains a non-finalized or wrong-turn order');
        }
        return Object.freeze({
          id: toId<'OrderId'>(order.id),
          campaignId: toId<'CampaignId'>(row.campaign_id),
          countryId: toId<'CountryId'>(order.country_id),
          turnNumber: toTurnNumber(order.turn_number),
          type: order.order_type,
          schemaVersion: order.schema_version,
          status: 'finalized' as const,
          payload: Object.freeze(asJsonRecord(order.payload, 'Order payload')) as TPayload,
        });
      }),
    );
    const turnSeed = await loadSeedForWorker(tx, keyProvider, {
      campaignId: claim.campaignId,
      turnNumber: claim.turnNumber,
      rulesetVersion: row.ruleset_version,
      rngVersion: row.rng_version,
    });
    await tx.query('COMMIT');
    active = false;
    return Object.freeze({ snapshot, orders, ruleset: Object.freeze(ruleset), turnSeed });
  } catch (error) {
    if (active) await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
