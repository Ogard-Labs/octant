import { protectedEntryFor } from "@octant/domain/secret-guard-policy";
import { lstatSync, opendirSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
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
      readonly proposedEntryProtected?: boolean;
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
  readonly lstat: (path: Buffer) => BigIntStats;
  readonly stat: (path: Buffer) => BigIntStats;
  readonly realpath: (path: Buffer) => Buffer;
  readonly names: (path: Buffer) => Iterable<string>;
}
export interface LinuxMediationProposedEntry {
  readonly parentObject: string;
  /** Empty only for an unnamed temporary file in this actual directory. */
  readonly name: Buffer;
}
const HOST_METADATA: LinuxMediationMetadata = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  stat: (path) => statSync(path, { bigint: true }),
  realpath: (path) => realpathSync(path, { encoding: "buffer" }),
  *names(path) {
    const directory = opendirSync(path, { encoding: "latin1" });
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) return;
        yield entry.name;
      }
    } finally {
      directory.closeSync();
    }
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
 * The bounded scan is synchronous there: only the surrounding namespace reads
 * schedule asynchronous work, rather than one microtask for every path entry.
 */
export async function readLinuxMediationPolicy(
  policy: SecretGuardMediationPolicy,
  readNamespace: () => Promise<LinuxMediationNamespace>,
  metadata: LinuxMediationMetadata = HOST_METADATA,
  proposedEntry?: LinuxMediationProposedEntry,
): Promise<LinuxMediationPolicySnapshot> {
  try {
    if (
      proposedEntry !== undefined &&
      (!/^\d+:\d+:[1-9]\d*$/.test(proposedEntry.parentObject) ||
        proposedEntry.name.length > 255 ||
        proposedEntry.name.includes(0) ||
        proposedEntry.name.includes(47) ||
        proposedEntry.name.equals(Buffer.from(".")) ||
        proposedEntry.name.equals(Buffer.from("..")))
    )
      return { status: "unavailable", reason: "metadata-unavailable" };
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
    let proposedEntryProtected = false;
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
    const inspect = (path: string, forced = false) => {
      if (!checkBudget()) return undefined;
      try {
        const link = metadata.lstat(nativePath(path));
        // A protected dangling link still has readable link text/metadata.
        // Record its own inode before following, without turning a missing
        // target into an omitted protected object or an account exemption.
        if (forced || protectedEntryFor([path], entries, own) !== undefined)
          objects.add(linuxMediationObjectKey(link));
        if (!checkBudget()) return undefined;
        const identity = link.isSymbolicLink() ? metadata.stat(nativePath(path)) : link;
        if (!checkBudget()) return undefined;
        const actual = metadata.realpath(nativePath(path)).toString("latin1");
        if (
          proposedEntry !== undefined &&
          identity.isDirectory() &&
          linuxMediationObjectKey(identity) === proposedEntry.parentObject
        ) {
          const name = proposedEntry.name.toString("latin1");
          const forms = name === "" ? [path, actual] : [join(path, name), join(actual, name)];
          if (forced || protectedEntryFor(forms, entries, own) !== undefined)
            proposedEntryProtected = true;
        }
        if (forced || protectedEntryFor([path, actual], entries, own) !== undefined) {
          objects.add(linuxMediationObjectKey(link));
          objects.add(linuxMediationObjectKey(identity));
        }
        return identity;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    };
    const namesIn = (path: string): ReadonlyArray<string> | undefined => {
      if (!checkBudget()) return undefined;
      try {
        const names: string[] = [];
        // Stream entries: a hostile large directory must not allocate an
        // unbounded readdir result before its metadata budget is checked.
        for (const name of metadata.names(nativePath(path))) {
          if (!checkBudget()) return undefined;
          names.push(name);
        }
        return names;
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    };
    const visit = (path: string, remaining: number, level: number, forced = false): void => {
      const identity = inspect(path, forced);
      if (identity === undefined || !identity.isDirectory() || remaining === 0) return;
      if (level >= MAX_DIRECTORY_DEPTH) {
        complete = false;
        return;
      }
      if (!checkBudget()) return;
      // A link may lead to the real store. The lexical form remains beside its
      // target; depth and metadata bounds turn cycles into refusal, not omission.
      const children = namesIn(path);
      if (children === undefined) return;
      for (const name of children) visit(join(path, name), remaining - 1, level + 1, forced);
    };
    for (const entry of entries) {
      const path = entry.kind === "path" ? entry.path : entry.directory;
      // An absent exact file has no inode to visit. Its real parent still
      // binds a proposed name, including another path to that same directory.
      if (proposedEntry !== undefined && entry.kind === "path") inspect(dirname(path));
      visit(path, entry.kind === "path" ? MAX_DIRECTORY_DEPTH + 1 : entry.depth, 0);
    }
    if (policy.sshCompanionDirectory !== undefined) {
      if (!checkBudget()) return { status: "unavailable", reason: "metadata-unavailable" };
      const directory = bytePath(policy.sshCompanionDirectory);
      const names = namesIn(directory);
      if (names === undefined) return { status: "unavailable", reason: "metadata-unavailable" };
      const present = new Set(names);
      if (proposedEntry !== undefined && proposedEntry.name.length > 0) {
        const identity = inspect(directory);
        const name = proposedEntry.name.toString("latin1");
        if (
          identity !== undefined &&
          linuxMediationObjectKey(identity) === proposedEntry.parentObject &&
          !name.endsWith(".pub") &&
          present.has(`${name}.pub`)
        )
          proposedEntryProtected = true;
      }
      for (const name of names)
        if (!name.endsWith(".pub") && present.has(`${name}.pub`))
          visit(join(directory, name), MAX_DIRECTORY_DEPTH + 1, 0, true);
    }
    if (!checkBudget()) return { status: "unavailable", reason: "metadata-unavailable" };
    const after = await readNamespace();
    if (after.activeMutations !== 0 || after.epoch !== before.epoch)
      return { status: "unavailable", reason: "namespace-changed" };
    return {
      status: "ready",
      epoch: after.epoch,
      protectedObjects: objects,
      ...(proposedEntry === undefined ? {} : { proposedEntryProtected }),
    };
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
