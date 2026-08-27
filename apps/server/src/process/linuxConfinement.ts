import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import {
  SeatbeltConfinementError,
  type ConfinedProcessLaunch,
  type SeatbeltConfinementPrepareInput,
} from "./seatbeltProfile";

export const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";

export interface BuildLinuxConfinementLaunchInput {
  readonly bwrapPath?: string;
}

export function requireLinuxConfinement(bwrapPath: string): void {
  if (!isAbsolute(bwrapPath)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Bubblewrap path must be absolute.",
    );
  }
  try {
    accessSync(bwrapPath, constants.X_OK);
  } catch {
    throw new SeatbeltConfinementError(
      "incompatible",
      "Linux confinement requires an executable bubblewrap (bwrap) runtime.",
    );
  }
}

export function buildLinuxConfinementLaunch(
  input: SeatbeltConfinementPrepareInput,
  options: BuildLinuxConfinementLaunchInput = {},
): ConfinedProcessLaunch {
  const bwrapPath = options.bwrapPath ?? DEFAULT_BWRAP_PATH;
  requireLinuxConfinement(bwrapPath);

  if (!isAbsolute(input.executable)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Linux-confined executable path must be absolute.",
    );
  }
  if (!isAbsolute(input.boundRoot)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Linux confinement bound root must be absolute.",
    );
  }
  if (!isAbsolute(input.temporaryDirectory)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Linux confinement temporary directory must be absolute.",
    );
  }
  if (input.extraRules !== undefined && input.extraRules.length > 0) {
    throw new SeatbeltConfinementError(
      "incompatible",
      "Linux confinement does not support extra Seatbelt rules.",
    );
  }

  const args: string[] = ["--unshare-all"];
  if (input.networkEgress === "allow") {
    args.push("--share-net");
  }
  args.push("--new-session", "--die-with-parent");

  args.push("--proc", "/proc", "--dev", "/dev");

  if (input.networkEgress === "allow" && existsSync("/run/systemd/resolve")) {
    args.push("--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve");
  }

  const baseSystemDirs = ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc", "/opt", "/sys"];
  const mounts = new Map<string, Mount>();

  function addMount(kind: "ro-bind" | "bind" | "tmpfs", source: string, target: string) {
    const normalizedTarget = normalize(target);
    const existing = mounts.get(normalizedTarget);
    if (existing !== undefined) {
      if (kind === "bind") {
        existing.kind = "bind";
        existing.source = source;
      } else if (existing.kind !== "bind" && kind === "tmpfs") {
        existing.kind = "tmpfs";
        existing.source = "";
      }
      return;
    }
    mounts.set(normalizedTarget, { kind, source, target: normalizedTarget });
  }

  function tryBindReadOnly(path: string) {
    if (!existsSync(path)) return;
    const source = safeRealpathSync(path);
    if (source === undefined) return;
    addMount("ro-bind", source, path);
  }

  function tryBindWritable(path: string) {
    if (!existsSync(path)) return;
    const source = safeRealpathSync(path);
    if (source === undefined) return;
    addMount("bind", source, path);
  }

  for (const dir of baseSystemDirs) {
    if (existsSync(dir)) {
      try {
        if (statSync(dir).isDirectory()) {
          tryBindReadOnly(dir);
        }
      } catch {
        // ignore broken symlinks
      }
    }
  }

  for (const path of input.readRoots ?? []) {
    tryBindReadOnly(path);
  }
  for (const path of input.privateHomeAllowPaths ?? []) {
    tryBindReadOnly(path);
  }

  if (input.writeBoundRoot !== false) {
    tryBindWritable(input.boundRoot);
  } else {
    tryBindReadOnly(input.boundRoot);
  }
  tryBindWritable(input.temporaryDirectory);
  for (const path of input.additionalWriteRoots ?? []) {
    tryBindWritable(path);
  }

  const writeTargets = [
    ...(input.writeBoundRoot !== false ? [input.boundRoot] : []),
    input.temporaryDirectory,
    ...(input.additionalWriteRoots ?? []),
  ].map((path) => normalize(path));

  function bindAdditionalDenyPath(path: string, _kind: "read" | "write"): void {
    if (!isAbsolute(path)) {
      throw new SeatbeltConfinementError(
        "invalid-configuration",
        `Linux confinement additional deny ${_kind} path "${path}" must be absolute.`,
      );
    }
    const normalized = normalize(path);

    // Deny paths are only meaningful when they overlap a writable mount.
    // Otherwise the read-only root already blocks access.
    if (
      !isStrictAncestorOfAny(normalized, writeTargets) &&
      !isAnyStrictAncestorOf(normalized, writeTargets)
    ) {
      return;
    }

    const existing = mounts.get(normalized);
    if (existing !== undefined && existing.kind === "bind") {
      // A writable mount at the exact same path must win; do not overwrite it
      // with a denial.
      return;
    }

    // A writable child bound under this path must be able to create its
    // mountpoint, and a read-only bind of an empty directory would block that.
    // Create a fresh tmpfs at the deny path instead; it is remounted read-only
    // after the child binds are applied, leaving the child writable.
    if (isDirectoryForDeny(path)) {
      addMount("tmpfs", "", normalized);
      return;
    }

    const source = createEmptySourceForPath(path);
    if (source !== undefined) {
      addMount("ro-bind", source, normalized);
    }
  }

  for (const path of input.additionalDenyWritePaths ?? []) {
    bindAdditionalDenyPath(path, "write");
  }

  for (const path of input.additionalDenyReadPaths ?? []) {
    bindAdditionalDenyPath(path, "read");
  }

  const sorted = [...mounts.values()].sort(
    (left, right) => depth(left.target) - depth(right.target),
  );
  for (const mount of sorted) {
    if (mount.kind === "tmpfs") {
      args.push("--tmpfs", mount.target);
    } else {
      args.push(mount.kind === "bind" ? "--bind" : "--ro-bind", mount.source, mount.target);
    }
  }

  for (const mount of sorted) {
    if (mount.kind === "tmpfs") {
      args.push("--remount-ro", mount.target);
    }
  }

  args.push("--remount-ro", "/");
  args.push("--chdir", input.boundRoot);
  args.push("--", input.executable);
  args.push(...input.args);

  return { command: bwrapPath, args };
}

interface Mount {
  kind: "ro-bind" | "bind" | "tmpfs";
  source: string;
  target: string;
}

function depth(path: string): number {
  return path.split(sep).filter((segment) => segment.length > 0).length;
}

function isStrictAncestorOfAny(path: string, candidates: ReadonlyArray<string>): boolean {
  const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
  return candidates.some((candidate) => candidate !== path && candidate.startsWith(prefix));
}

function isAnyStrictAncestorOf(path: string, candidates: ReadonlyArray<string>): boolean {
  for (const candidate of candidates) {
    if (candidate === path) continue;
    const prefix = candidate.endsWith(sep) ? candidate : `${candidate}${sep}`;
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

function safeRealpathSync(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isDirectoryForDeny(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // Deny paths are typically directories, and a nonexistent directory is
    // hidden the same way by mounting an empty tmpfs at the target.
    return true;
  }
}

const emptySourcePaths = new Map<string, string>();

function createEmptySourceForPath(path: string): string | undefined {
  const cached = emptySourcePaths.get(path);
  if (cached !== undefined) return cached;

  try {
    const stats = lstatSync(path);
    if (stats.isFile() || stats.isSymbolicLink()) {
      const source = mkdtempSync(join(tmpdir(), "octant-deny-"));
      const file = join(source, "file");
      writeFileSync(file, "");
      emptySourcePaths.set(path, file);
      return file;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
