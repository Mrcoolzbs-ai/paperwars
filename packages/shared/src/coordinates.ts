export interface Coordinates {
  readonly x: number;
  readonly y: number;
}

function assertCoordinate(value: number, axis: 'x' | 'y'): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Coordinate ${axis} must be a safe integer; received ${value}`);
  }
}

export function createCoordinates(x: number, y: number): Coordinates {
  assertCoordinate(x, 'x');
  assertCoordinate(y, 'y');
  return Object.freeze({ x, y });
}

export function coordinatesEqual(a: Coordinates, b: Coordinates): boolean {
  return a.x === b.x && a.y === b.y;
}

export function coordinatesKey(value: Coordinates): string {
  return `${value.x}:${value.y}`;
}

export function neighbors4(value: Coordinates): readonly Coordinates[] {
  return [
    createCoordinates(value.x + 1, value.y),
    createCoordinates(value.x - 1, value.y),
    createCoordinates(value.x, value.y + 1),
    createCoordinates(value.x, value.y - 1),
  ];
}

export function neighbors8(value: Coordinates): readonly Coordinates[] {
  return [
    ...neighbors4(value),
    createCoordinates(value.x + 1, value.y + 1),
    createCoordinates(value.x - 1, value.y - 1),
    createCoordinates(value.x + 1, value.y - 1),
    createCoordinates(value.x - 1, value.y + 1),
  ];
}

export function manhattanDistance(a: Coordinates, b: Coordinates): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function chebyshevDistance(a: Coordinates, b: Coordinates): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
