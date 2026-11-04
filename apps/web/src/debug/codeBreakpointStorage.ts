import { Schema } from "effect";
import {
  CodeCheckoutId,
  CodeFileId,
  CodeFileMetadata,
  CodeProjectFilePath,
  CodeThreadId,
} from "@octant/contracts/code";
import {
  CodeDebugBreakpoint,
  MAX_CODE_DEBUG_BREAKPOINT_FILES,
  MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE,
} from "@octant/contracts/code-debug";
import { ProjectId } from "@octant/contracts/projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const PREFIX = "octant.debug.breakpoints.v1:";
const PURGED = "octant.debug.breakpoints.purged.v1:";
const MAX_BYTES = 1024 * 1024;
const MAX_KEYS = 4096;
const Binding = Schema.Struct({
  projectId: ProjectId,
  fileId: CodeFileId,
  metadata: CodeFileMetadata,
  unconfirmed: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type CodeBreakpointBinding = typeof Binding.Type;
const SavedFile = Schema.Struct({
  path: CodeProjectFilePath,
  lines: Schema.Array(CodeDebugBreakpoint.fields.line).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE),
    Schema.filter((lines) =>
      lines.every((line, index) => index === 0 || line > (lines[index - 1] ?? 0)),
    ),
  ),
  binding: Schema.optional(Binding),
}).annotations(strict);
export type SavedCodeBreakpointFile = typeof SavedFile.Type;
const Configuration = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Array(SavedFile).pipe(
    Schema.maxItems(MAX_CODE_DEBUG_BREAKPOINT_FILES),
    Schema.filter((files) => new Set(files.map((file) => file.path)).size === files.length),
  ),
}).annotations(strict);
const decode = Schema.decodeUnknownSync(Configuration);
export const isCodeBreakpointLine = Schema.is(CodeDebugBreakpoint.fields.line);
const decodeThreadKey = Schema.decodeUnknownSync(Schema.Tuple(CodeThreadId, CodeCheckoutId));
const decodeStorageKey = Schema.decodeUnknownSync(
  Schema.Tuple(Schema.String, Schema.String, CodeThreadId, CodeCheckoutId),
);

export interface CodeBreakpointScope {
  /** Endpoint namespace only; it is never an authorization or physical-host identity. */
  readonly origin: string;
  readonly windowId: string;
}
export type CodeBreakpointStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
export function defaultCodeBreakpointStorage(): CodeBreakpointStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
function parts(key: string): readonly [string, string] {
  return decodeThreadKey(JSON.parse(key));
}
function itemKey(scope: CodeBreakpointScope, key: string): string {
  return PREFIX + JSON.stringify([scope.origin, scope.windowId, ...parts(key)]);
}
function purgeKey(scope: CodeBreakpointScope, threadId: string): string {
  return PURGED + JSON.stringify([scope.origin, threadId]);
}
export function breakpointStorageEventMatches(
  scope: CodeBreakpointScope,
  key: string | null,
  threadKey?: string,
): boolean {
  if (key === null) return true;
  try {
    if (key.startsWith(PREFIX)) {
      const identity = decodeStorageKey(JSON.parse(key.slice(PREFIX.length)));
      return (
        identity[0] === scope.origin &&
        identity[1] === scope.windowId &&
        (threadKey === undefined || key === itemKey(scope, threadKey))
      );
    }
    if (key.startsWith(PURGED)) {
      const value: unknown = JSON.parse(key.slice(PURGED.length));
      return (
        Array.isArray(value) &&
        value[0] === scope.origin &&
        (threadKey === undefined || key === purgeKey(scope, parts(threadKey)[0]))
      );
    }
  } catch {
    /* Another preference or a malformed key has no effect on this store. */
  }
  return false;
}
export type BreakpointStorageReading =
  | { readonly status: "read"; readonly files: ReadonlyArray<SavedCodeBreakpointFile> }
  | { readonly status: "empty" | "purged" | "unavailable" };
export function readCodeBreakpointConfiguration(
  storage: CodeBreakpointStorage | undefined,
  scope: CodeBreakpointScope,
  key: string,
): BreakpointStorageReading {
  if (storage === undefined) return { status: "unavailable" };
  try {
    if (storage.getItem(purgeKey(scope, parts(key)[0])) !== null) return { status: "purged" };
    const raw = storage.getItem(itemKey(scope, key));
    if (raw === null) return { status: "empty" };
    if (raw.length > MAX_BYTES) return { status: "unavailable" };
    return { status: "read", files: decode(JSON.parse(raw)).files };
  } catch {
    return { status: "unavailable" };
  }
}
export function writeCodeBreakpointConfiguration(
  storage: CodeBreakpointStorage | undefined,
  scope: CodeBreakpointScope,
  key: string,
  files: ReadonlyArray<SavedCodeBreakpointFile>,
): "saved" | "purged" | "unavailable" {
  if (storage === undefined) return "unavailable";
  try {
    const name = itemKey(scope, key);
    const tombstone = purgeKey(scope, parts(key)[0]);
    if (storage.getItem(tombstone) !== null) {
      storage.removeItem(name);
      return "purged";
    }
    const previous = readCodeBreakpointConfiguration(storage, scope, key);
    // A new toggle must not silently replace a corrupt, possibly recoverable record.
    if (previous.status === "unavailable") return "unavailable";
    if (files.length === 0) storage.removeItem(name);
    else {
      const raw = JSON.stringify(decode({ version: 1, files }));
      if (raw.length > MAX_BYTES) return "unavailable";
      storage.setItem(name, raw);
    }
    // A cooperative writer in another window can race the purge's key scan.
    // The marker is written first, so this post-check cannot resurrect it.
    if (storage.getItem(tombstone) !== null) {
      storage.removeItem(name);
      return "purged";
    }
    return "saved";
  } catch {
    return "unavailable";
  }
}
export function purgeCodeBreakpointConfiguration(
  storage: CodeBreakpointStorage | undefined,
  scope: CodeBreakpointScope,
  threadId: string,
): boolean {
  if (storage === undefined) return false;
  try {
    storage.setItem(purgeKey(scope, threadId), "1");
    if (storage.length > MAX_KEYS) return false;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key === null || !key.startsWith(PREFIX)) continue;
      let identity: ReturnType<typeof decodeStorageKey>;
      try {
        identity = decodeStorageKey(JSON.parse(key.slice(PREFIX.length)));
      } catch {
        /* Never remove an unrelated or unrecognizable preference. */
        continue;
      }
      if (identity[0] === scope.origin && String(identity[2]) === threadId) storage.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}
