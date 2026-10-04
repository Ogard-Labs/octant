import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const text = (max: number) => Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(max));

export const ManagedToolUpdateState = Schema.Literal(
  "idle",
  "checking",
  "downloading",
  "staged",
  "current",
  "failed",
);
export type ManagedToolUpdateState = typeof ManagedToolUpdateState.Type;

export const ManagedToolStatus = Schema.Struct({
  tool: text(64),
  packageName: text(128),
  channel: Schema.Literal("npm"),
  /** False when the tool cannot be located on this host at all. */
  available: Schema.Boolean,
  /** True when an installed release is active rather than the bundled pin. */
  installed: Schema.Boolean,
  version: text(64),
  update: ManagedToolUpdateState,
  availableVersion: Schema.optional(text(64)),
  message: Schema.optional(text(1_024)),
  /** Managed directory updates may write. Absent for tools that are not executables. */
  managedDirectory: Schema.optional(text(4_096)),
  /** Stable path of the managed executable, when one is installed. */
  executablePath: Schema.optional(text(4_096)),
}).annotations(strict);
export type ManagedToolStatus = typeof ManagedToolStatus.Type;

export const ManagedToolsSettings = Schema.Struct({
  automaticUpdates: Schema.optionalWith(Schema.Boolean, { default: () => true }),
}).annotations(strict);
export type ManagedToolsSettings = typeof ManagedToolsSettings.Type;
export const decodeManagedToolsSettings = Schema.decodeUnknownSync(ManagedToolsSettings);

export const ManagedToolsStatus = Schema.Struct({
  supported: Schema.Boolean,
  automaticUpdates: Schema.Boolean,
  tools: Schema.Array(ManagedToolStatus),
  message: Schema.optional(text(1_024)),
}).annotations(strict);
export type ManagedToolsStatus = typeof ManagedToolsStatus.Type;
export const decodeManagedToolsStatus = Schema.decodeUnknownSync(ManagedToolsStatus);
