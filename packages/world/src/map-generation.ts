export type WorldTerrainCode = 'l' | 'w' | 'r';

export interface GeneratedWorldMap {
  readonly width: number;
  readonly height: number;
  readonly seed: string;
  /** Row-major terrain codes: l = land, w = sea, r = river. */
  readonly terrain: string;
  readonly landCellCount: number;
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mix32(value: number): number {
  let result = value >>> 0;
  result = Math.imul(result ^ (result >>> 16), 0x7feb352d);
  result = Math.imul(result ^ (result >>> 15), 0x846ca68b);
  return (result ^ (result >>> 16)) >>> 0;
}

function latticeValue(x: number, y: number, seed: number): number {
  const mixed = mix32(
    seed ^ Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77),
  );
  return mixed / 0xffffffff;
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const north = latticeValue(x0, y0, seed) * (1 - tx) + latticeValue(x0 + 1, y0, seed) * tx;
  const south =
    latticeValue(x0, y0 + 1, seed) * (1 - tx) + latticeValue(x0 + 1, y0 + 1, seed) * tx;
  return north * (1 - ty) + south * ty;
}

function fractalNoise(x: number, y: number, seed: number): number {
  let total = 0;
  let weight = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let octave = 0; octave < 5; octave += 1) {
    total += valueNoise(x * frequency, y * frequency, mix32(seed + octave * 0x9e3779b9)) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return total / weight;
}

function neighbors(index: number, width: number, height: number): number[] {
  const x = index % width;
  const y = Math.floor(index / width);
  const result: number[] = [];
  if (y > 0) result.push(index - width);
  if (x + 1 < width) result.push(index + 1);
  if (y + 1 < height) result.push(index + width);
  if (x > 0) result.push(index - 1);
  return result;
}

function carveRiver(
  source: number,
  width: number,
  height: number,
  land: Uint8Array,
  elevation: Float32Array,
  terrain: string[],
  seed: number,
): void {
  const count = width * height;
  const previous = new Int32Array(count);
  previous.fill(-2);
  const queue = new Int32Array(count);
  let read = 0;
  let write = 0;
  queue[write++] = source;
  previous[source] = -1;
  let outlet = -1;

  while (read < write && outlet < 0) {
    const current = queue[read++]!;
    const adjacent = neighbors(current, width, height);
    if (adjacent.some((cell) => land[cell] === 0)) {
      outlet = current;
      break;
    }
    const tieSeed = mix32(seed ^ current);
    adjacent.sort((left, right) => {
      const slope = elevation[left]! - elevation[right]!;
      if (Math.abs(slope) > 0.0001) return slope;
      return mix32(tieSeed ^ left) - mix32(tieSeed ^ right);
    });
    for (const next of adjacent) {
      if (land[next] === 1 && previous[next] === -2) {
        previous[next] = current;
        queue[write++] = next;
      }
    }
  }

  if (outlet < 0) return;
  let cursor = outlet;
  while (cursor >= 0) {
    if (terrain[cursor] === 'l') terrain[cursor] = 'r';
    cursor = previous[cursor]!;
  }
}

export function generateWorldMap(seedInput: string, width: number, height: number): GeneratedWorldMap {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 20 || height < 20) {
    throw new RangeError('World map dimensions must be safe integers of at least 20x20');
  }
  if (width > 200 || height > 200 || width * height > 40_000) {
    throw new RangeError('World maps are limited to 200x200 cells');
  }
  const seed = seedInput.trim();
  if (!seed || seed.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(seed)) {
    throw new RangeError('World seed must contain 1 to 64 letters, digits, underscores or hyphens');
  }

  const seedNumber = hashString(seed);
  const size = width * height;
  const land = new Uint8Array(size);
  const elevation = new Float32Array(size);
  const terrain = new Array<string>(size);
  const minDimension = Math.min(width, height);
  let landCellCount = 0;

  const warpScaleX = Math.max(5, width * 0.14);
  const warpScaleY = Math.max(5, height * 0.14);
  const continentScaleX = Math.max(5, width * 0.19);
  const continentScaleY = Math.max(5, height * 0.19);
  const detailScale = Math.max(3, minDimension * 0.075);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const warpX =
        (fractalNoise(x / warpScaleX + 19.7, y / warpScaleY - 5.3, seedNumber ^ 0x68bc21eb) - 0.5) *
        width *
        0.095;
      const warpY =
        (fractalNoise(x / warpScaleX - 11.2, y / warpScaleY + 23.1, seedNumber ^ 0x02e5be93) - 0.5) *
        height *
        0.095;
      const continental = fractalNoise(
        (x + warpX) / continentScaleX,
        (y + warpY) / continentScaleY,
        seedNumber ^ 0x967a889b,
      );
      const detail = fractalNoise(
        x / detailScale + 43.1,
        y / detailScale - 17.8,
        seedNumber ^ 0x4cf5ad43,
      );
      const latitude = Math.sin(((y / Math.max(1, height - 1)) * Math.PI * 2) + seedNumber / 0xffffffff);
      const landness = continental * 0.76 + detail * 0.24 + latitude * 0.018;
      const index = y * width + x;
      elevation[index] = landness;
      if (landness > 0.505) {
        land[index] = 1;
        terrain[index] = 'l';
        landCellCount += 1;
      } else {
        terrain[index] = 'w';
      }
    }
  }

  const sourceCandidates: number[] = [];
  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const index = y * width + x;
      if (land[index] !== 1 || elevation[index]! < 0.59) continue;
      let surroundedByLand = true;
      for (let dy = -2; dy <= 2 && surroundedByLand; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (land[(y + dy) * width + x + dx] !== 1) {
            surroundedByLand = false;
            break;
          }
        }
      }
      if (surroundedByLand) sourceCandidates.push(index);
    }
  }
  sourceCandidates.sort((left, right) => elevation[right]! - elevation[left]!);
  const riverCount = Math.min(8, Math.max(2, Math.floor(size / 2_400)));
  const riverSources: number[] = [];
  for (const candidate of sourceCandidates) {
    const x = candidate % width;
    const y = Math.floor(candidate / width);
    if (
      riverSources.every((source) => {
        const sx = source % width;
        const sy = Math.floor(source / width);
        return Math.hypot(sx - x, sy - y) >= Math.max(8, minDimension * 0.18);
      })
    ) {
      riverSources.push(candidate);
      if (riverSources.length >= riverCount) break;
    }
  }
  for (let index = 0; index < riverSources.length; index += 1) {
    carveRiver(
      riverSources[index]!,
      width,
      height,
      land,
      elevation,
      terrain,
      mix32(seedNumber + index * 0x9e3779b9),
    );
  }

  return { width, height, seed, terrain: terrain.join(''), landCellCount };
}
