import { Data } from "effect";

export class MigrationChecksumMismatch extends Data.TaggedError("MigrationChecksumMismatch")<{
  readonly version: number;
  readonly name: string;
}> {}

export class MigrationHistoryMismatch extends Data.TaggedError("MigrationHistoryMismatch")<{
  readonly version: number;
  readonly name: string;
}> {}

export class DatabaseVersionTooNew extends Data.TaggedError("DatabaseVersionTooNew")<{
  readonly databaseVersion: number;
  readonly latestKnownVersion: number;
}> {}

export class MigrationFailed extends Data.TaggedError("MigrationFailed")<{
  readonly version: number;
  readonly name: string;
}> {}
