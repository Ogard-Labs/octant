import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
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

  function addMount(kind: "ro-bind" | "bind", source: string, target: string) {
    const normalizedTarget = normalize(target);
    const existing = mounts.get(normalizedTarget);
    if (existing !== undefined) {
      if (kind === "bind") {
        existing.kind = "bind";
        existing.source = source;
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
    if (existsSync(dir) && lstatSync(dir).isDirectory()) {
      tryBindReadOnly(dir);
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

  for (const path of input.additionalDenyWritePaths ?? []) {
    bindAdditionalDenyPath(path, writeTargets, mounts, "write");
  }

  for (const path of input.additionalDenyReadPaths ?? []) {
    bindAdditionalDenyPath(path, writeTargets, mounts, "read");
  }

  const sorted = [...mounts.values()].sort(
    (left, right) => depth(left.target) - depth(right.target),
  );
  for (const mount of sorted) {
    args.push(mount.kind === "bind" ? "--bind" : "--ro-bind", mount.source, mount.target);
  }

  args.push("--remount-ro", "/");
  args.push("--chdir", input.boundRoot);
  args.push("--", input.executable);
  args.push(...input.args);

  return { command: bwrapPath, args };
}

interface Mount {
  kind: "ro-bind" | "bind";
  source: string;
  target: string;
}

function depth(path: string): number {
  return path.split(sep).filter((segment) => segment.length > 0).length;
}

function bindAdditionalDenyPath(
  path: string,
  writeTargets: ReadonlyArray<string>,
  mounts: Map<string, Mount>,
  _kind: "read" | "write",
): void {
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

  // Replace the denied path with an empty source. If the path is an ancestor
  // of a writable target, the writable child is bound later and overlays the
  // empty parent for that subtree.
  const source = createEmptySourceForPath(path);
  if (source !== undefined) {
    const existing = mounts.get(normalized);
    if (existing !== undefined && existing.kind === "bind") {
      // A writable mount at the exact same path must win; do not overwrite it
      // with a denial.
      return;
    }
    mounts.set(normalized, { kind: "ro-bind", source, target: normalized });
  }
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

const emptySourcePaths = new Map<string, string>();

function createEmptySourceForPath(path: string): string | undefined {
  const cached = emptySourcePaths.get(path);
  if (cached !== undefined) return cached;

  try {
    const stats = lstatSync(path);
    if (stats.isDirectory()) {
      const source = mkdtempSync(join(tmpdir(), "octant-deny-"));
      emptySourcePaths.set(path, source);
      return source;
    }
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
