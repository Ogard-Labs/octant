/**
 * Whether a runtime's reported version is at least `floor`, as a release:
 * a prerelease such as `0.145.0-alpha.1` predates `0.145.0`. Shared by the
 * drivers that gate behaviour on a runtime release they measured.
 */
export function isAtLeastRelease(
  version: string,
  floor: readonly [number, number, number],
): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(-)?/.exec(version);
  if (match === null) return false;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (const [index, part] of core.entries()) {
    const floorPart = floor[index] ?? 0;
    if (part !== floorPart) return part > floorPart;
  }
  return match[4] === undefined;
}
