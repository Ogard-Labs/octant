import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { AggregateId, EventActor, UtcTimestamp } from "@octant/contracts";
import {
  HostUpdateDrain,
  HostUpdateFailureReason,
  HostUpdateHostKind,
  HostUpdateRing,
  HostUpdateStep,
} from "@octant/contracts/host-control";
import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const BoundedLabel = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));
const BoundedPath = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096));

export const HostUpdateTerminalOutcome = Schema.Literal(
  "updated",
  "rolled-back",
  "recovery-required",
  "failed",
);
export type HostUpdateTerminalOutcome = typeof HostUpdateTerminalOutcome.Type;

/**
 * Atomic terminal result written in the host's state directory by the
 * out-of-service upgrade runner. Whichever version starts next reads this file,
 * journals `host-update.step@1`, keeps the status for callers to read, and
 * removes the file. Carries no URLs, file paths, or raw command output.
 */
export const HostUpdateResultFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requestId: AggregateId,
  actor: EventActor,
  hostKind: HostUpdateHostKind,
  fromVersion: BoundedLabel,
  toVersion: BoundedLabel,
  ring: HostUpdateRing,
  drain: HostUpdateDrain,
  storeMigration: Schema.Boolean,
  outcome: HostUpdateTerminalOutcome,
  step: HostUpdateStep,
  failureReason: Schema.optional(HostUpdateFailureReason),
  storeRestored: Schema.optional(Schema.Boolean),
  completedAt: UtcTimestamp,
}).annotations(strict);
export type HostUpdateResultFile = typeof HostUpdateResultFile.Type;

/**
 * Pending marker written in the state directory right before launching the
 * out-of-service upgrade runner, so the next host start knows an upgrade was
 * in flight and watches briefly if the runner writes the result file right
 * after the new host passes its health check.
 */
export const HostUpdatePendingFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requestId: AggregateId,
  actor: EventActor,
  hostKind: HostUpdateHostKind,
  fromVersion: BoundedLabel,
  toVersion: BoundedLabel,
  ring: HostUpdateRing,
  drain: HostUpdateDrain,
  storeMigration: Schema.Boolean,
  startedAt: UtcTimestamp,
}).annotations(strict);
export type HostUpdatePendingFile = typeof HostUpdatePendingFile.Type;

/**
 * Private context file written inside the state directory and passed to
 * `octant server upgrade --update-context <path>` by the out-of-service runner.
 */
export const HostUpdateContextFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requestId: AggregateId,
  actor: EventActor,
  hostKind: Schema.Literal("headless"),
  fromVersion: BoundedLabel,
  toVersion: BoundedLabel,
  ring: HostUpdateRing,
  drain: HostUpdateDrain,
  storeMigration: Schema.Boolean,
  resultPath: BoundedPath,
  cleanupWorkDir: Schema.optional(BoundedPath),
  cleanupLaunchdPlist: Schema.optional(BoundedPath),
}).annotations(strict);
export type HostUpdateContextFile = typeof HostUpdateContextFile.Type;

export const decodeHostUpdateResultFile = Schema.decodeUnknownSync(HostUpdateResultFile, {
  onExcessProperty: "error",
});
export const decodeHostUpdatePendingFile = Schema.decodeUnknownSync(HostUpdatePendingFile, {
  onExcessProperty: "error",
});
export const decodeHostUpdateContextFile = Schema.decodeUnknownSync(HostUpdateContextFile, {
  onExcessProperty: "error",
});

/** True when `candidate` resolves inside `directory` (never escaping via `..`). */
export function isPathConfinedWithin(directory: string, candidate: string): boolean {
  const resolvedDirectory = resolve(directory);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate === resolvedDirectory) return false;
  const rel = relative(resolvedDirectory, resolvedCandidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function assertNotSymlinkIfPresent(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Refused to touch non-regular file at ${path}.`);
    }
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return;
    throw error;
  }
}

async function writeAtomicPrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertNotSymlinkIfPresent(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readPrivateJson<T>(
  path: string,
  decode: (value: unknown) => T,
): Promise<T | undefined> {
  let raw: string;
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return undefined;
    return undefined;
  }
  try {
    return decode(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function writeHostUpdateResultFile(
  path: string,
  result: HostUpdateResultFile,
): Promise<void> {
  decodeHostUpdateResultFile(result);
  await writeAtomicPrivateJson(path, result);
}

export async function readHostUpdateResultFile(
  path: string,
): Promise<HostUpdateResultFile | undefined> {
  return readPrivateJson(path, decodeHostUpdateResultFile);
}

export async function clearHostUpdateResultFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function writeHostUpdatePendingFile(
  path: string,
  pending: HostUpdatePendingFile,
): Promise<void> {
  decodeHostUpdatePendingFile(pending);
  await writeAtomicPrivateJson(path, pending);
}

export async function readHostUpdatePendingFile(
  path: string,
): Promise<HostUpdatePendingFile | undefined> {
  return readPrivateJson(path, decodeHostUpdatePendingFile);
}

export async function clearHostUpdatePendingFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function writeHostUpdateContextFile(
  path: string,
  context: HostUpdateContextFile,
): Promise<void> {
  decodeHostUpdateContextFile(context);
  await writeAtomicPrivateJson(path, context);
}

export async function readHostUpdateContextFile(
  path: string,
): Promise<HostUpdateContextFile | undefined> {
  return readPrivateJson(path, decodeHostUpdateContextFile);
}
