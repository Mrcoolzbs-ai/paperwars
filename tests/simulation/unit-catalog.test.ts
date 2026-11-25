import { describe, expect, it } from 'vitest';
import {
  getCombatUnitStats,
  getUnitUpkeep,
  listCombatUnitDefinitions,
} from '@paper-wars/worker';

describe('baseline combat unit catalogue', () => {
  it('contains the five publicly available starting combat units', () => {
    expect(listCombatUnitDefinitions().map((unit) => unit.type)).toEqual([
      'swordsman',
      'archer',
      'shieldbearer',
      'cavalryman',
      'blade_master',
    ]);
  });

  it('uses the current science level to resolve swordsman characteristics', () => {
    expect(getCombatUnitStats('swordsman', 1)).toMatchObject({
      initiative: 1,
      evasionFaces: 1,
      armor: 0,
      health: 2,
      attack: 1,
      line: 1,
      upkeep: 1,
    });
    expect(getCombatUnitStats('swordsman', 6)).toMatchObject({
      initiative: 4,
      evasionFaces: 4,
      armor: 2,
      health: 10,
      attack: 3,
    });
  });

  it('keeps the archer in the second line and gives it the documented range', () => {
    expect(getCombatUnitStats('archer', 1)).toMatchObject({
      initiative: 2,
      evasionFaces: 1,
      armor: 0,
      health: 2,
      attack: 2,
      line: 2,
      targetableLines: [1, 2],
    });
  });

  it('requires two and three science for shieldbearers and cavalry', () => {
    expect(() => getCombatUnitStats('shieldbearer', 1)).toThrow(RangeError);
    expect(getCombatUnitStats('shieldbearer', 2)).toMatchObject({
      evasionFaces: 0,
      initiative: 0,
      armor: 2,
      health: 2,
      attack: 1,
      line: 1,
    });
    expect(() => getCombatUnitStats('cavalryman', 2)).toThrow(RangeError);
    expect(getCombatUnitStats('cavalryman', 3)).toMatchObject({
      evasionFaces: 0,
      initiative: 2,
      armor: 0,
      health: 3,
      attack: 3,
      line: 2,
      targetableLines: [1, 2, 3],
      opponentEvasionBonusWhenAttacking: 1,
      upkeep: 2,
    });
  });

  it('keeps blade master evasion and initiative fixed while other traits scale', () => {
    expect(getCombatUnitStats('blade_master', 1)).toMatchObject({
      evasionFaces: 4,
      initiative: 0,
      armor: 0,
      health: 1,
      attack: 1,
      upkeep: 2,
    });
    expect(getCombatUnitStats('blade_master', 6)).toMatchObject({
      evasionFaces: 4,
      initiative: 0,
      armor: 1,
      health: 4,
      attack: 2,
    });
  });

  it('calculates maintenance from each unit type rather than counting all units as one coin', () => {
    expect(
      getUnitUpkeep([
        { type: 'swordsman' },
        { type: 'archer' },
        { type: 'cavalryman' },
        { type: 'blade_master' },
      ]),
    ).toBe(5);
  });
});
