export const TURN_PHASE_ORDER = [
  'PREPARE_TURN',
  'APPLY_ENVIRONMENT',
  'VALIDATE',
  'RESOLVE_CONFLICTS',
  'MOVE',
  'COLONIZE',
  'BUILD',
  'RESEARCH',
  'DIPLOMACY',
  'BATTLE',
  'ECONOMY',
  'SEASONAL_EVENTS',
  'EVENTS',
  'FINALIZE',
] as const;

export type TurnPhase = (typeof TURN_PHASE_ORDER)[number];
