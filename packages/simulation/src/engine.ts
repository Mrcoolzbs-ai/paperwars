export interface SimulationEngineConfig {
  readonly rulesetVersion: string;
  readonly rngVersion: string;
}

/** Metadata only. Turn resolution is intentionally not implemented in Stage 1.1. */
export interface SimulationEngineDescriptor {
  readonly engineVersion: string;
  readonly rulesetVersion: string;
  readonly rngVersion: string;
}

export function createSimulationEngine(config: SimulationEngineConfig): SimulationEngineDescriptor {
  if (config.rulesetVersion.trim().length === 0) {
    throw new RangeError('rulesetVersion must not be empty');
  }
  if (config.rngVersion.trim().length === 0) {
    throw new RangeError('rngVersion must not be empty');
  }

  return Object.freeze({
    engineVersion: '0.1.0',
    rulesetVersion: config.rulesetVersion,
    rngVersion: config.rngVersion,
  });
}
