import { protectedEntryFor } from "@octant/domain/secret-guard-policy";
import type { BigIntStats } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SecretGuardMediationPolicy } from "./secretGuard";

export interface LinuxMediationNamespace {
  readonly epoch: bigint;
  readonly activeMutations: number;
}
export type LinuxMediationPolicySnapshot =
  | {
      readonly status: "ready";
      readonly epoch: bigint;
      readonly protectedObjects: ReadonlySet<string>;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "namespace-changing" | "namespace-changed" | "metadata-unavailable";
    };

/** Match the kernel's separate major/minor fields; never truncate inode ids. */
export function linuxMediationObjectKey(identity: {
  readonly dev: bigint;
  readonly ino: bigint;
}): string {
  const major = ((identity.dev >> 8n) & 0xfffn) | ((identity.dev >> 32n) & 0xfffff000n);
  const minor = (identity.dev & 0xffn) | ((identity.dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}:${identity.ino}`;
}

export interface LinuxMediationMetadata {
  readonly stat: (path: Buffer) => Promise<BigIntStats>;
  readonly realpath: (path: Buffer) => Promise<Buffer>;
  readonly names: (path: Buffer) => AsyncIterable<string>;
}
const HOST_METADATA: LinuxMediationMetadata = {
  stat: (path) => stat(path, { bigint: true }),
  realpath: (path) => realpath(path, { encoding: "buffer" }),
  async *names(path) {
    const directory = await opendir(path, { encoding: "latin1" });
    for await (const entry of directory) yield entry.name;
  },
};

const MAX_METADATA_OPERATIONS = 65_536;
const MAX_DIRECTORY_DEPTH = 64;
const SNAPSHOT_BUDGET_MS = 1_000;

/**
 * Metadata-only policy snapshot for the deny-only kernel bridge. The broker
 * must still send the returned epoch to the kernel's final atomic admission;
 * this optimistic scan cannot itself authorize a workload operation. It runs
 * in the owned broker process, not under a VFS lock or in the app request loop.
 */
export async function readLinuxMediationPolicy(
  policy: SecretGuardMediationPolicy,
  readNamespace: () => Promise<LinuxMediationNamespace>,
  metadata: LinuxMediationMetadata = HOST_METADATA,
): Promise<LinuxMediationPolicySnapshot> {
  try {
    const before = await readNamespace();
    if (before.activeMutations !== 0 || before.epoch <= 0n)
      return { status: "unavailable", reason: "namespace-changing" };
    const deadline = performance.now() + SNAPSHOT_BUDGET_MS;
    let operations = 0;
    let complete = true;
    const checkBudget = () => {
      operations += 1;
      if (operations > MAX_METADATA_OPERATIONS || performance.now() > deadline) complete = false;
      return complete;
    };
    const objects = new Set<string>();
    // Directory entries may contain arbitrary non-NUL bytes on Linux. A
    // one-byte representation preserves identity and ASCII rule syntax; UTF-8
    // replacement decoding could silently omit a protected id_<invalid> name.
    const bytePath = (path: string) => Buffer.from(path, "utf8").toString("latin1");
    const nativePath = (path: string) => Buffer.from(path, "latin1");
    const entries = policy.entries.map((entry) =>
      entry.kind === "path"
        ? { ...entry, path: bytePath(entry.path) }
        : { ...entry, directory: bytePath(entry.directory) },
    );
    const own: string[] = [];
    for (const original of policy.ownAccountPaths) {
      const path = bytePath(original);
      if (!path.startsWith("/") || path.includes("\0"))
        return { status: "unavailable", reason: "metadata-unavailable" };
      own.push(path);
      if (!checkBudget()) return { status: "unavailable", reason: "metadata-unavailable" };
    }
    const inspect = async (path: string, forced = false) => {
      if (!checkBudget()) return undefined;
      try {
        const identity = await metadata.stat(nativePath(path));
        if (!checkBudget()) return undefined;
        const actual = (await metadata.realpath(nativePath(path))).toString("latin1");
        if (forced || protectedEntryFor([path, actual], entries, own) !== undefined)
          objects.add(linuxMediationObjectKey(identity));
        return identity;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    };
    const namesIn = async (path: string): Promise<ReadonlyArray<string> | undefined> => {
      if (!checkBudget()) return undefined;
      try {
        const names: string[] = [];
        // Stream entries: a hostile large directory must not allocate an
        // unbounded readdir result before its metadata budget is checked.
        for await (const name of metadata.names(nativePath(path))) {
          if (!checkBudget()) return undefined;
          names.push(name);
        }
        return names;
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    };
    const visit = async (
      path: string,
      remaining: number,
      level: number,
      forced = false,
    ): Promise<void> => {
      const identity = await inspect(path, forced);
      if (identity === undefined || !identity.isDirectory() || remaining === 0) return;
      if (level >= MAX_DIRECTORY_DEPTH) {
        complete = false;
        return;
      }
      if (!checkBudget()) return;
      // A link may lead to the real store. The lexical form remains beside its
      // target; depth and metadata bounds turn cycles into refusal, not omission.
      const children = await namesIn(path);
      if (children === undefined) return;
      for (const name of children) await visit(join(path, name), remaining - 1, level + 1, forced);
    };
    for (const entry of entries) {
      const path = entry.kind === "path" ? entry.path : entry.directory;
      await visit(path, entry.kind === "path" ? MAX_DIRECTORY_DEPTH + 1 : entry.depth, 0);
    }
    if (policy.sshCompanionDirectory !== undefined) {
      if (!checkBudget()) return { status: "unavailable", reason: "metadata-unavailable" };
      const directory = bytePath(policy.sshCompanionDirectory);
      const names = await namesIn(directory);
      if (names === undefined) return { status: "unavailable", reason: "metadata-unavailable" };
      const present = new Set(names);
      for (const name of names)
        if (!name.endsWith(".pub") && present.has(`${name}.pub`))
          await visit(join(directory, name), MAX_DIRECTORY_DEPTH + 1, 0, true);
    }
    if (!checkBudget()) return { status: "unavailable", reason: "metadata-unavailable" };
    const after = await readNamespace();
    if (after.activeMutations !== 0 || after.epoch !== before.epoch)
      return { status: "unavailable", reason: "namespace-changed" };
    return { status: "ready", epoch: after.epoch, protectedObjects: objects };
  } catch {
    return { status: "unavailable", reason: "metadata-unavailable" };
  }
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
