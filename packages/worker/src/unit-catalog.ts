export type CombatUnitType =
  | 'swordsman'
  | 'archer'
  | 'shieldbearer'
  | 'cavalryman'
  | 'blade_master';

export interface CombatUnitDefinition {
  readonly type: CombatUnitType;
  readonly name: string;
  readonly requiredScience: number;
  readonly upkeep: number;
  readonly line: number;
  readonly targetableLines: readonly number[];
  /** Number of d6 faces that make an incoming attack miss. */
  readonly evasionFacesByScience: readonly number[];
  readonly initiativeByScience: readonly number[];
  readonly armorByScience: readonly number[];
  readonly healthByScience: readonly number[];
  readonly attackByScience: readonly number[];
  /** Attackers receive this many additional evasion faces when targeting the unit. */
  readonly attackerEvasionBonus: number;
}

export interface CombatUnitStats {
  readonly type: CombatUnitType;
  readonly name: string;
  readonly scienceLevel: number;
  readonly requiredScience: number;
  readonly upkeep: number;
  readonly initiative: number;
  readonly evasionFaces: number;
  readonly armor: number;
  readonly health: number;
  readonly attack: number;
  readonly line: number;
  readonly targetableLines: readonly number[];
  readonly attackerEvasionBonus: number;
}

export interface RecruitedUnitState {
  readonly id: string;
  readonly type: CombatUnitType;
  readonly barracksCellId: string;
  readonly barracksX: number;
  readonly barracksY: number;
  readonly currentHealth: number;
  readonly recruitedAtTurn: number;
}

const DEFINITIONS: Readonly<Record<CombatUnitType, CombatUnitDefinition>> = {
  swordsman: {
    type: 'swordsman',
    name: 'Солдат-мечник',
    requiredScience: 1,
    upkeep: 1,
    line: 1,
    targetableLines: [1],
    evasionFacesByScience: [1, 2, 2, 3, 3, 4],
    initiativeByScience: [1, 2, 2, 3, 3, 4],
    armorByScience: [0, 0, 0, 1, 1, 2],
    healthByScience: [2, 4, 4, 6, 6, 10],
    attackByScience: [1, 1, 2, 2, 3, 3],
    attackerEvasionBonus: 0,
  },
  archer: {
    type: 'archer',
    name: 'Солдат-лучник',
    requiredScience: 1,
    upkeep: 1,
    line: 2,
    targetableLines: [1, 2],
    evasionFacesByScience: [1, 2, 3, 4, 4, 4],
    initiativeByScience: [2, 3, 3, 4, 4, 5],
    armorByScience: [0, 0, 0, 0, 1, 1],
    healthByScience: [2, 4, 4, 6, 6, 10],
    attackByScience: [2, 2, 3, 3, 4, 4],
    attackerEvasionBonus: 0,
  },
  shieldbearer: {
    type: 'shieldbearer',
    name: 'Солдат-щитоносец',
    requiredScience: 2,
    upkeep: 1,
    line: 1,
    targetableLines: [1],
    evasionFacesByScience: [0, 0, 0, 0, 1],
    initiativeByScience: [0, 1, 1, 2, 2],
    armorByScience: [2, 3, 3, 3, 3],
    healthByScience: [2, 3, 4, 4, 6],
    attackByScience: [1, 1, 1, 1, 2],
    attackerEvasionBonus: 0,
  },
  cavalryman: {
    type: 'cavalryman',
    name: 'Солдат-всадник',
    requiredScience: 3,
    upkeep: 2,
    line: 2,
    targetableLines: [1, 2, 3],
    evasionFacesByScience: [0, 0, 0, 0],
    initiativeByScience: [2, 3, 3, 4],
    armorByScience: [0, 0, 1, 2],
    healthByScience: [3, 5, 5, 8],
    attackByScience: [3, 4, 5, 6],
    attackerEvasionBonus: 1,
  },
  blade_master: {
    type: 'blade_master',
    name: 'Мастер клинка',
    requiredScience: 1,
    upkeep: 2,
    line: 1,
    targetableLines: [1],
    evasionFacesByScience: [4, 4, 4, 4, 4, 4],
    initiativeByScience: [0, 0, 0, 0, 0, 0],
    armorByScience: [0, 0, 0, 0, 0, 1],
    healthByScience: [1, 2, 2, 3, 3, 4],
    attackByScience: [1, 1, 1, 2, 2, 2],
    attackerEvasionBonus: 0,
  },
};

function scienceIndex(type: CombatUnitType, currentScience: number): number {
  const definition = DEFINITIONS[type];
  if (!Number.isSafeInteger(currentScience) || currentScience < definition.requiredScience) {
    throw new RangeError(`${definition.name} requires ${definition.requiredScience} science`);
  }
  return Math.min(6, currentScience) - (type === 'shieldbearer' ? 2 : type === 'cavalryman' ? 3 : 1);
}

export function getCombatUnitDefinition(type: CombatUnitType): CombatUnitDefinition {
  return DEFINITIONS[type];
}

export function listCombatUnitDefinitions(): readonly CombatUnitDefinition[] {
  return Object.values(DEFINITIONS);
}

export function getCombatUnitStats(
  type: CombatUnitType,
  currentScience: number,
): CombatUnitStats {
  const definition = DEFINITIONS[type];
  const index = scienceIndex(type, currentScience);
  return {
    type,
    name: definition.name,
    scienceLevel: Math.min(6, currentScience),
    requiredScience: definition.requiredScience,
    upkeep: definition.upkeep,
    initiative: definition.initiativeByScience[index]!,
    evasionFaces: definition.evasionFacesByScience[index]!,
    armor: definition.armorByScience[index]!,
    health: definition.healthByScience[index]!,
    attack: definition.attackByScience[index]!,
    line: definition.line,
    targetableLines: definition.targetableLines,
    attackerEvasionBonus: definition.attackerEvasionBonus,
  };
}

export function isCombatUnitType(value: unknown): value is CombatUnitType {
  return typeof value === 'string' && Object.hasOwn(DEFINITIONS, value);
}

export function getUnitUpkeep(
  units: readonly Pick<RecruitedUnitState, 'type'>[],
): number {
  return units.reduce((sum, unit) => sum + DEFINITIONS[unit.type].upkeep, 0);
}
