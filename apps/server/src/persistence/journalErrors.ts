import { Data } from "effect";

export class DuplicateEventRegistration extends Data.TaggedError("DuplicateEventRegistration")<{
  readonly eventName: string;
  readonly eventVersion: number;
}> {}

export class UnknownEventName extends Data.TaggedError("UnknownEventName")<{
  readonly eventName: string;
}> {}

export class UnsupportedEventVersion extends Data.TaggedError("UnsupportedEventVersion")<{
  readonly eventName: string;
  readonly eventVersion: number;
}> {}

export class EventPayloadInvalid extends Data.TaggedError("EventPayloadInvalid")<{
  readonly eventName: string;
  readonly eventVersion: number;
}> {}

export class JournalInputInvalid extends Data.TaggedError("JournalInputInvalid")<{
  readonly operation: "append" | "replay";
}> {}

export class ConcurrencyConflict extends Data.TaggedError("ConcurrencyConflict")<{
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}> {}

export class DuplicateEventIdentity extends Data.TaggedError("DuplicateEventIdentity")<{
  readonly eventId: string;
}> {}

export class JournalWriteFailed extends Data.TaggedError("JournalWriteFailed")<{
  readonly operation: "append";
}> {}

export type SqliteFailureKind = "unique-constraint" | "write-race" | "storage";

const SQLITE_STORAGE_CODE_PREFIXES = [
  "SQLITE_IOERR",
  "SQLITE_FULL",
  "SQLITE_READONLY",
  "SQLITE_CANTOPEN",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_PROTOCOL",
  "SQLITE_INTERRUPT",
  "SQLITE_NOMEM",
  "SQLITE_PERM",
  "SQLITE_AUTH",
] as const;

export function classifySqliteFailure(error: unknown): SqliteFailureKind | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  if (typeof code !== "string") return undefined;
  if (code === "SQLITE_CONSTRAINT_UNIQUE") return "unique-constraint";
  if (
    code === "SQLITE_BUSY" ||
    code.startsWith("SQLITE_BUSY_") ||
    code === "SQLITE_LOCKED" ||
    code.startsWith("SQLITE_LOCKED_")
  ) {
    return "write-race";
  }
  if (
    SQLITE_STORAGE_CODE_PREFIXES.some((prefix) => code === prefix || code.startsWith(`${prefix}_`))
  ) {
    return "storage";
  }
  return undefined;
}

export function isSqliteStorageFailure(error: unknown): boolean {
  const failureKind = classifySqliteFailure(error);
  return failureKind === "write-race" || failureKind === "storage";
}

export type ReplayFailureReason =
  | "malformed-json"
  | "unknown-event-name"
  | "unsupported-event-version"
  | "event-payload-invalid"
  | "event-envelope-invalid";

export class ReplayEventInvalid extends Data.TaggedError("ReplayEventInvalid")<{
  readonly eventId: string;
  readonly globalSequence: number;
  readonly eventName: string;
  readonly eventVersion: number;
  readonly reason: ReplayFailureReason;
}> {}
