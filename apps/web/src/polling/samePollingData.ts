/**
 * Polling responses are freshly decoded objects even when the host state did
 * not change. Keep the current reference in that case so React can bail out
 * of the update and its dependent surfaces do not rerender on every tick.
 */
export function samePollingData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => samePollingData(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftRecord = left;
  const rightRecord = right;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      samePollingData(leftRecord[key], rightRecord[key]),
  );
}

function isRecord(value: object): value is Readonly<Record<string, unknown>> {
  return !Array.isArray(value);
}
