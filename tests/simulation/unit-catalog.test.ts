import { describe, expect, it } from 'vitest';
import {
  getArmySizeProfile,
  getCombatUnitStats,
  getGeneralUpkeep,
  getGeneralsUpkeep,
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

  it('uses the Fibonacci maintenance table for server-generated general quality', () => {
    expect(Array.from({ length: 7 }, (_, stars) => getGeneralUpkeep(stars))).toEqual([
      2, 3, 5, 8, 13, 21, 34,
    ]);
    expect(() => getGeneralUpkeep(-1)).toThrow(RangeError);
    expect(() => getGeneralUpkeep(7)).toThrow(RangeError);
  });

  it('calculates total general maintenance', () => {
    expect(
      getGeneralsUpkeep([
        { upkeep: getGeneralUpkeep(0) },
        { upkeep: getGeneralUpkeep(2) },
        { upkeep: getGeneralUpkeep(4) },
      ]),
    ).toBe(20);
  });

  it('assigns the Q23 army size bands and movement ranges at every boundary', () => {
    expect(getArmySizeProfile(1)).toEqual({
      size: 'light',
      romanNumeral: 'I',
      movementRange: 7,
    });
    expect(getArmySizeProfile(10)).toMatchObject({ size: 'light', romanNumeral: 'I', movementRange: 7 });
    expect(getArmySizeProfile(11)).toMatchObject({ size: 'medium', romanNumeral: 'II', movementRange: 5 });
    expect(getArmySizeProfile(20)).toMatchObject({ size: 'medium', romanNumeral: 'II', movementRange: 5 });
    expect(getArmySizeProfile(21)).toMatchObject({ size: 'heavy', romanNumeral: 'III', movementRange: 3 });
    expect(getArmySizeProfile(30)).toMatchObject({ size: 'heavy', romanNumeral: 'III', movementRange: 3 });
    expect(getArmySizeProfile(31)).toMatchObject({ size: 'huge', romanNumeral: 'IV', movementRange: 1 });
    expect(getArmySizeProfile(40)).toMatchObject({ size: 'huge', romanNumeral: 'IV', movementRange: 1 });
    expect(() => getArmySizeProfile(0)).toThrow(RangeError);
    expect(() => getArmySizeProfile(41)).toThrow(RangeError);
  });

  it('calculates maintenance from each unit type rather than counting all units as one coin', () => {
    expect(
      getUnitUpkeep([
        { type: 'swordsman' },
        { type: 'archer' },
        { type: 'cavalryman' },
        { type: 'blade_master' },
      ]),
    ).toBe(6);
  });
});
