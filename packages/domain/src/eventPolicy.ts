export type VersionAssignment =
  | { readonly ok: true; readonly versions: ReadonlyArray<number> }
  | {
      readonly ok: false;
      readonly expectedVersion: number;
      readonly actualVersion: number;
    };

export function assignAggregateVersions(
  expectedVersion: number,
  actualVersion: number,
  eventCount: number,
): VersionAssignment {
  if (!Number.isSafeInteger(eventCount) || eventCount < 1) {
    throw new Error("eventCount must be positive");
  }
  if (expectedVersion !== actualVersion) {
    return { ok: false, expectedVersion, actualVersion };
  }
  return {
    ok: true,
    versions: Array.from({ length: eventCount }, (_, index) => actualVersion + index + 1),
  };
}

export type CheckpointState = "current" | "lagging" | "invalid";

export function classifyCheckpoint(lastSequence: number, journalHead: number): CheckpointState {
  if (lastSequence > journalHead) return "invalid";
  if (lastSequence < journalHead) return "lagging";
  return "current";
}
