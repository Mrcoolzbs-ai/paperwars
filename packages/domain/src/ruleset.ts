import { ApplicationError } from '@paper-wars/shared';
import type { WorldSnapshot } from './contracts.js';

export interface RulesetManifest {
  readonly rulesetVersion: string;
  readonly rngVersion: string;
  readonly worldStateSchemaVersion: number;
  readonly supportedEngineVersions: readonly string[];
}

export interface RulesetDefinition<TParameters extends object> extends RulesetManifest {
  readonly parameters: Readonly<TParameters>;
}

export interface EngineVersionDescriptor {
  readonly engineVersion: string;
  readonly rulesetVersion: string;
  readonly rngVersion: string;
}

export class RulesetCompatibilityError extends ApplicationError {
  constructor(message: string) {
    super('RULESET_INCOMPATIBLE', message);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RulesetCompatibilityError(`${field} must not be empty`);
  }
}

export function validateRulesetManifest(manifest: RulesetManifest): void {
  assertNonEmpty(manifest.rulesetVersion, 'rulesetVersion');
  assertNonEmpty(manifest.rngVersion, 'rngVersion');

  if (
    !Number.isSafeInteger(manifest.worldStateSchemaVersion) ||
    manifest.worldStateSchemaVersion < 1
  ) {
    throw new RulesetCompatibilityError('worldStateSchemaVersion must be a positive safe integer');
  }

  if (
    manifest.supportedEngineVersions.length === 0 ||
    manifest.supportedEngineVersions.some(
      (version) => typeof version !== 'string' || version.trim().length === 0,
    )
  ) {
    throw new RulesetCompatibilityError('At least one non-empty supported engine version is required');
  }

  if (new Set(manifest.supportedEngineVersions).size !== manifest.supportedEngineVersions.length) {
    throw new RulesetCompatibilityError('supportedEngineVersions must not contain duplicates');
  }
}

export function assertRulesetCompatible(
  manifest: RulesetManifest,
  engine: EngineVersionDescriptor,
): void {
  validateRulesetManifest(manifest);
  if (manifest.rulesetVersion !== engine.rulesetVersion) {
    throw new RulesetCompatibilityError(
      `Ruleset version ${manifest.rulesetVersion} does not match engine selection ${engine.rulesetVersion}`,
    );
  }
  if (manifest.rngVersion !== engine.rngVersion) {
    throw new RulesetCompatibilityError(
      `RNG version ${manifest.rngVersion} does not match engine selection ${engine.rngVersion}`,
    );
  }
  if (!manifest.supportedEngineVersions.includes(engine.engineVersion)) {
    throw new RulesetCompatibilityError(
      `Engine version ${engine.engineVersion} is not supported by ruleset ${manifest.rulesetVersion}`,
    );
  }
}

export function assertSnapshotCompatible<TState>(
  snapshot: WorldSnapshot<TState>,
  manifest: RulesetManifest,
): void {
  validateRulesetManifest(manifest);
  if (snapshot.rulesetVersion !== manifest.rulesetVersion) {
    throw new RulesetCompatibilityError(
      `Snapshot ruleset ${snapshot.rulesetVersion} does not match ${manifest.rulesetVersion}`,
    );
  }
  if (snapshot.stateSchemaVersion !== manifest.worldStateSchemaVersion) {
    throw new RulesetCompatibilityError(
      `Snapshot schema version ${snapshot.stateSchemaVersion} is not supported; expected ${manifest.worldStateSchemaVersion}`,
    );
  }
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
    throw new RulesetCompatibilityError('Snapshot version must be a positive safe integer');
  }
}
