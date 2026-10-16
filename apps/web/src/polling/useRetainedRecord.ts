import { useRef } from "react";

/**
 * The record from the previous render while every own field is the same
 * value, otherwise this render's record.
 *
 * A controller hook returns an object literal, so its consumers see a new
 * identity on every render even when nothing in it moved, and a surface
 * wrapped in `memo` cannot tell a quiet render from a change. Held here, the
 * object changes identity only when one of its fields does. The held record
 * can never carry a stale value: it is returned only while each of its fields
 * is the value this render computed, so a render React abandons can at most
 * leave behind an object with the very same values.
 */
export function useRetainedRecord<T extends object>(record: T): T {
  const held = useRef(record);
  if (!sameOwnFields(held.current, record)) held.current = record;
  return held.current;
}

function sameOwnFields(left: object, right: object): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!Object.is(Reflect.get(left, key), Reflect.get(right, key))) return false;
  }
  return true;
}
