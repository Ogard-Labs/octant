import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import {
  SeatbeltConfinementError,
  type ConfinedProcessLaunch,
  type SeatbeltConfinementPrepareInput,
} from "./seatbeltProfile";
import { buildLinuxProcessDenySeccompFilter } from "./linuxProcessDenySeccomp";

export const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";
const HOST_SH_PATH = "/bin/sh";

export interface BuildLinuxConfinementLaunchInput {
  readonly bwrapPath?: string;
  readonly processArch?: NodeJS.Architecture;
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
  const hostExecutableSearchPaths = [
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];
  const mounts = new Map<string, Mount>();

  function addMount(kind: Mount["kind"], source: string, target: string) {
    const normalizedTarget = normalize(target);
    const existing = mounts.get(normalizedTarget);
    if (existing !== undefined) {
      if (kind === "bind") {
        existing.kind = "bind";
        existing.source = source;
        return;
      }
      if (existing.kind === "ro-bind" && (kind === "tmpfs" || kind === "tmpfs-rw")) {
        existing.kind = kind;
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
  // Shared host temp roots stay private tmpfs. Binding /tmp (or /var/tmp)
  // would let confined code read and write every other process's files there.
  // `--remount-ro /` does not remount those writable binds.
  addMount("tmpfs-rw", "", "/tmp");
  if (existsSync("/var/tmp") || isSharedHostTemporaryRoot(input.temporaryDirectory)) {
    addMount("tmpfs-rw", "", "/var/tmp");
  }
  if (!isSharedHostTemporaryRoot(input.temporaryDirectory)) {
    tryBindWritable(input.temporaryDirectory);
  }
  for (const path of input.additionalWriteRoots ?? []) {
    tryBindWritable(path);
  }
  // Bubblewrap applies seccomp before execve of the command, so a filter that
  // blocked execve would prevent the launch itself. Overlay host executable
  // search paths, re-bind this launch's binary, then load a process-deny
  // seccomp program that blocks fork/clone (and execveat) after start. See 0068.
  const denyProcessFork = input.allowProcessFork === false;
  const denyProcessExec = input.allowProcessExec === false;
  if (denyProcessFork || denyProcessExec) {
    for (const path of hostExecutableSearchPaths) {
      if (existsSync(path)) addMount("tmpfs", "", path);
    }
    tryBindReadOnly(input.executable);
  }

  const writeTargets = [
    ...(input.writeBoundRoot !== false ? [input.boundRoot] : []),
    ...(isSharedHostTemporaryRoot(input.temporaryDirectory) ? [] : [input.temporaryDirectory]),
    ...(input.additionalWriteRoots ?? []),
    "/tmp",
    ...(existsSync("/var/tmp") || isSharedHostTemporaryRoot(input.temporaryDirectory)
      ? ["/var/tmp"]
      : []),
  ].map((path) => normalize(path));

  function bindAdditionalDenyPath(path: string, kind: "read" | "write"): void {
    if (!isAbsolute(path)) {
      throw new SeatbeltConfinementError(
        "invalid-configuration",
        `Linux confinement additional deny ${kind} path "${path}" must be absolute.`,
      );
    }
    const normalized = normalize(path);
    // Write denials only matter on writable mounts. Read denials must also
    // cover read-only binds: a `--ro-bind` of a parent still exposes the
    // denied child unless we overlay it.
    const overlapTargets = kind === "write" ? writeTargets : [...mounts.keys()];
    if (
      !overlapTargets.includes(normalized) &&
      !isStrictAncestorOfAny(normalized, overlapTargets) &&
      !isAnyStrictAncestorOf(normalized, overlapTargets)
    ) {
      return;
    }

    const existing = mounts.get(normalized);
    if (existing !== undefined && (existing.kind === "bind" || existing.kind === "tmpfs-rw")) {
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
    if (mount.kind === "tmpfs" || mount.kind === "tmpfs-rw") {
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

  if (denyProcessFork || denyProcessExec) {
    const filter = buildLinuxProcessDenySeccompFilter({
      arch: linuxSeccompArch(options.processArch ?? process.arch),
      denyFork: denyProcessFork,
      denyExec: denyProcessExec,
    });
    const seccompPath = writeProcessDenySeccompFilter(
      input.temporaryDirectory,
      filter,
      `${denyProcessFork ? "-fork" : ""}${denyProcessExec ? "-exec" : ""}`,
    );
    return wrapLinuxLaunchWithSeccomp(bwrapPath, args, seccompPath);
  }

  return { command: bwrapPath, args };
}

interface Mount {
  kind: "ro-bind" | "bind" | "tmpfs" | "tmpfs-rw";
  source: string;
  target: string;
}

function writeProcessDenySeccompFilter(
  temporaryDirectory: string,
  filter: Uint8Array,
  suffix: string,
): string {
  assertNoSymlinkComponents(temporaryDirectory);
  const parentStats = lstatSync(temporaryDirectory);
  if (!parentStats.isDirectory()) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Linux confinement temporary directory must be a directory.",
    );
  }
  const directory = mkdtempSync(join(temporaryDirectory, "octant-seccomp-"));
  chmodSync(directory, 0o700);
  const seccompPath = join(directory, `process-deny${suffix}.bpf`);
  writeFileSync(seccompPath, filter, { mode: 0o600 });
  return seccompPath;
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new SeatbeltConfinementError(
          "invalid-configuration",
          "Linux confinement temporary directory must not contain symbolic links.",
        );
      }
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}

function linuxSeccompArch(arch: NodeJS.Architecture): "x64" | "arm64" {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new SeatbeltConfinementError(
    "incompatible",
    "Linux process denial requires an x64 or arm64 kernel.",
  );
}

function wrapLinuxLaunchWithSeccomp(
  bwrapPath: string,
  bwrapArgs: ReadonlyArray<string>,
  seccompPath: string,
): ConfinedProcessLaunch {
  try {
    accessSync(HOST_SH_PATH, constants.X_OK);
  } catch {
    throw new SeatbeltConfinementError(
      "incompatible",
      "Linux process denial requires an executable /bin/sh to install the seccomp filter.",
    );
  }
  return {
    command: HOST_SH_PATH,
    args: [
      "-c",
      'bwrap="$1"; bpf="$2"; shift 2; exec "$bwrap" --seccomp 3 "$@" 3<"$bpf"',
      "octant-bwrap",
      bwrapPath,
      seccompPath,
      ...bwrapArgs,
    ],
  };
}

function isSharedHostTemporaryRoot(path: string): boolean {
  const normalized = normalize(path);
  return normalized === "/tmp" || normalized === "/var/tmp";
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
