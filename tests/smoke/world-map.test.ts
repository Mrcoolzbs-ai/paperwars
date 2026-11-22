import { describe, expect, it } from 'vitest';
import { generateWorldMap } from '@paper-wars/world';

describe('seeded world map generation', () => {
  it('reproduces identical continents and rivers for the same seed', () => {
    const first = generateWorldMap('reproducible-world-42', 80, 60);
    const second = generateWorldMap('reproducible-world-42', 80, 60);

    expect(second).toEqual(first);
    expect(first.terrain).toHaveLength(80 * 60);
    expect(first.terrain).toMatch(/r/);
    expect(first.landCellCount).toBe(
      Array.from(first.terrain).filter((cell) => cell === 'l').length,
    );
  });

  it('changes the generated world when the seed changes', () => {
    const first = generateWorldMap('western-continent', 80, 60);
    const second = generateWorldMap('eastern-continent', 80, 60);

    expect(second.terrain).not.toBe(first.terrain);
    expect(new Set(first.terrain).size).toBeGreaterThanOrEqual(2);
    expect(first.terrain).toMatch(/[lr]/);
    expect(first.terrain).toMatch(/[wr]/);
  });

  it('contains mixed land and water and supports partially coastal 5x5 starts', () => {
    const map = generateWorldMap('coastal-settlement', 80, 60);
    const waterCount = Array.from(map.terrain).filter((cell) => cell === 'w' || cell === 'r').length;
    expect(map.landCellCount).toBeGreaterThan(0);
    expect(waterCount).toBeGreaterThan(0);

    let hasValidStart = false;
    let hasCoastalStart = false;
    for (let y = 2; y < map.height - 2; y += 1) {
      for (let x = 2; x < map.width - 2; x += 1) {
        let land = 0;
        for (let yy = y - 2; yy <= y + 2; yy += 1) {
          for (let xx = x - 2; xx <= x + 2; xx += 1) {
            if (map.terrain[yy * map.width + xx] === 'l') land += 1;
          }
        }
        if (land >= 7) {
          hasValidStart = true;
          if (land < 25) hasCoastalStart = true;
        }
      }
    }
    expect(hasValidStart).toBe(true);
    expect(hasCoastalStart).toBe(true);
  });

  it('rejects invalid map dimensions and invalid seeds', () => {
    expect(() => generateWorldMap('valid-seed', 10, 10)).toThrow(RangeError);
    expect(() => generateWorldMap('', 80, 60)).toThrow(RangeError);
    expect(() => generateWorldMap('bad seed', 80, 60)).toThrow(RangeError);
    expect(() => generateWorldMap('valid-seed', 201, 60)).toThrow(RangeError);
  });
});
