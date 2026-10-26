import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import {
  confinedExecutableExecPaths,
  ProcessConfinementError,
  type ConfinedProcessLaunch,
  type ProcessConfinementPrepareInput,
} from "./seatbeltProfile";
import { buildLinuxProcessDenySeccompFilter } from "./linuxProcessDenySeccomp";
import { LINUX_EGRESS_FORWARDER_PORT, LINUX_EGRESS_FORWARDER_SOURCE } from "./proxiedNetworkEgress";

export const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";

/**
 * What a person sees when this host cannot confine a terminal for want of
 * bubblewrap. The command matches the one the `octant` command-line launcher
 * prints, so both places give the same fix.
 */
export const LINUX_BUBBLEWRAP_MISSING_NOTICE =
  "This Linux host is missing bubblewrap, which Octant needs to start a terminal safely. " +
  "Install it with: sudo apt-get install -y bubblewrap. Then start the terminal again.";
const HOST_SH_PATH = "/bin/sh";

export interface BuildLinuxConfinementLaunchInput {
  readonly bwrapPath?: string;
  readonly processArch?: NodeJS.Architecture;
  /**
   * The JavaScript runtime that runs a `proxied` launch's forwarder inside the
   * capsule. Defaults to the host's own runtime.
   */
  readonly forwarderRuntime?: string;
}

export interface LinuxAllowDefaultDenyLaunchInput {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly denyPaths: ReadonlyArray<string>;
}

/**
 * Full access on Linux: keep the host filesystem, then overlay the same
 * static denials Seatbelt applies with (allow default) plus trailing denies.
 */
export function buildLinuxAllowDefaultDenyLaunch(
  input: LinuxAllowDefaultDenyLaunchInput,
  options: BuildLinuxConfinementLaunchInput = {},
): ConfinedProcessLaunch {
  const bwrapPath = options.bwrapPath ?? DEFAULT_BWRAP_PATH;
  requireLinuxConfinement(bwrapPath);
  if (!isAbsolute(input.executable)) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Linux confinement executable path must be absolute.",
    );
  }
  if (!isAbsolute(input.cwd)) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Linux Full access working directory must be absolute.",
    );
  }
  const args: string[] = [
    "--die-with-parent",
    "--dev-bind",
    "/dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    "/",
    "/",
  ];
  for (const path of input.denyPaths) {
    if (!isAbsolute(path)) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        `Linux Full access deny path "${path}" must be absolute.`,
      );
    }
    const normalized = normalize(path);
    // The host root is bound writable here, so Bubblewrap would create a
    // missing mount point in the person's real folder and leave an empty
    // `.claude/skills` or `.agents` behind in their Project. A path that does
    // not exist holds nothing for a runtime to load when it starts.
    if (!pathExists(path)) continue;
    if (isDirectoryForDeny(path)) {
      args.push("--tmpfs", normalized, "--remount-ro", normalized);
      continue;
    }
    const source = createEmptySourceForPath(path);
    if (source === undefined) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        `Linux Full access deny path "${path}" could not be overlaid.`,
      );
    }
    args.push("--ro-bind", source, normalized);
  }
  args.push("--chdir", input.cwd, "--", input.executable, ...input.args);
  return { command: bwrapPath, args };
}

export function requireLinuxConfinement(bwrapPath: string): void {
  if (!isAbsolute(bwrapPath)) {
    throw new ProcessConfinementError("invalid-configuration", "Bubblewrap path must be absolute.");
  }
  try {
    accessSync(bwrapPath, constants.X_OK);
  } catch (error) {
    // Only an absent runtime is fixed by installing it. One that is there but
    // cannot be run (no execute bit, an unreadable parent) needs a different
    // fix, so it keeps the generic refusal rather than the install notice.
    const code = (error as NodeJS.ErrnoException).code;
    const absent = code === "ENOENT" || code === "ENOTDIR";
    throw new ProcessConfinementError(
      "incompatible",
      "Linux confinement requires an executable bubblewrap (bwrap) runtime.",
      absent ? "linux-bubblewrap-missing" : undefined,
    );
  }
}

export function buildBubblewrapLaunch(
  input: ProcessConfinementPrepareInput,
  options: BuildLinuxConfinementLaunchInput = {},
): ConfinedProcessLaunch {
  const bwrapPath = options.bwrapPath ?? DEFAULT_BWRAP_PATH;
  requireLinuxConfinement(bwrapPath);

  if (!isAbsolute(input.executable)) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Linux-confined executable path must be absolute.",
    );
  }
  if (!isAbsolute(input.boundRoot)) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Linux confinement bound root must be absolute.",
    );
  }
  if (!isAbsolute(input.temporaryDirectory)) {
    throw new ProcessConfinementError(
      "invalid-configuration",
      "Linux confinement temporary directory must be absolute.",
    );
  }
  if (input.extraRules !== undefined && input.extraRules.length > 0) {
    throw new ProcessConfinementError(
      "incompatible",
      "Linux confinement does not support extra Seatbelt rules.",
    );
  }

  // `proxied` keeps the private network namespace `--unshare-all` gives,
  // whose only interface is loopback, and reaches the host proxy through the
  // forwarder below; the capsule has no resolver to ask.
  const proxied = typeof input.networkEgress === "object" ? input.networkEgress : undefined;
  if (proxied !== undefined) {
    if (proxied.endpoint.kind !== "unix-socket" || !isAbsolute(proxied.endpoint.path)) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        "A proxied Linux launch needs its proxy's Unix socket.",
      );
    }
    if (input.allowProcessFork === false || input.allowProcessExec === false) {
      throw new ProcessConfinementError(
        "incompatible",
        "A proxied Linux launch starts its command from the forwarder, so it needs fork and exec.",
      );
    }
  }
  const args: string[] = ["--unshare-all"];
  if (input.networkEgress === "allow") {
    args.push("--share-net");
  }
  // An interactive shell keeps its controlling tty: `--new-session` calls
  // setsid, and measured on bwrap 0.6.1 the confined `bash -l` then printed
  // "cannot set terminal process group" and "no job control", refusing `fg`.
  if (input.terminal === undefined) {
    args.push("--new-session");
  }
  args.push("--die-with-parent");
  // Bubblewrap keeps every capability when it is started by uid 0. Measured on
  // bwrap 0.9.0 as root: the capsule could `mount -o remount,bind,rw` a
  // read-only bind and write through it, and `umount` a deny overlay to read
  // what it hid, so a root host's capsule was no boundary at all. Unprivileged
  // Bubblewrap already drops them; this makes both cases the same. A bwrap
  // older than 0.2.0 has no `--cap-drop` and exits on the unknown option
  // before starting the command, so the launch fails closed.
  args.push("--cap-drop", "ALL");

  args.push("--proc", "/proc", "--dev", "/dev");
  // Bubblewrap covers `/proc/sys` only when it can open the directory for
  // writing, which procfs never allows, so its own cover never applies. A
  // root host's capsule runs as the host's uid 0, and the kernel lets uid 0
  // write most sysctls by their owner bits alone: measured on bwrap 0.9.0
  // with every capability dropped, the capsule still wrote
  // `kernel.core_pattern`, which runs a program as host root on the next
  // crash. Sysctl values follow the reader's namespaces, not the procfs
  // mount, so binding the host's tree changes nothing a workload reads.
  args.push("--ro-bind", "/proc/sys", "/proc/sys");

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
  // The launch's own socket directory, read-only: connecting to a socket
  // needs no write to the mount, and the forwarder beside it cannot be
  // rewritten from inside. Only this launch's directory is bound, so no
  // other launch's socket is reachable.
  let forwarder: { readonly runtime: string; readonly script: string } | undefined;
  if (proxied !== undefined && proxied.endpoint.kind === "unix-socket") {
    const socketDirectory = dirname(proxied.endpoint.path);
    const script = join(socketDirectory, "forwarder.cjs");
    writeFileSync(script, LINUX_EGRESS_FORWARDER_SOURCE, { mode: 0o600 });
    const runtime = options.forwarderRuntime ?? process.execPath;
    if (!isAbsolute(runtime)) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        "The Linux egress forwarder runtime must be absolute.",
      );
    }
    addMount("ro-bind", socketDirectory, socketDirectory);
    tryBindReadOnly(dirname(runtime));
    forwarder = { runtime, script };
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
  }
  // A `#!` script starts through its interpreter. When process exec is denied
  // the mask above hides it along with everything else in those directories;
  // when exec stays allowed a launcher may still resolve its interpreter from
  // PATH outside the granted install tree, so the interpreter is mounted either
  // way. The Seatbelt builder lists the same programs for the same reason.
  for (const path of confinedExecutableExecPaths(
    input.executable,
    input.interpreterSearchPath ?? process.env.PATH,
  )) {
    // A bound install directory already carries its launcher symlinks. Binding
    // over one before its target is mounted can fail inside that read-only
    // directory. Keep the link (and argv[0]) when the nearest mount exposes it;
    // a tmpfs mask still needs the explicit executable bind below.
    const parent = [...mounts.values()]
      .filter((mount) => path.startsWith(`${mount.target}${sep}`))
      .sort((left, right) => right.target.length - left.target.length)[0];
    if (
      parent !== undefined &&
      (parent.kind === "ro-bind" || parent.kind === "bind") &&
      existsSync(path) &&
      lstatSync(path).isSymbolicLink() &&
      safeRealpathSync(join(parent.source, relative(parent.target, path))) ===
        safeRealpathSync(path)
    ) {
      continue;
    }
    tryBindReadOnly(path);
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
      throw new ProcessConfinementError(
        "invalid-configuration",
        `Linux confinement additional deny ${kind} path "${path}" must be absolute.`,
      );
    }
    for (const target of denyTargetsInCapsule(normalize(path), mounts)) {
      bindDenyTarget(target, kind);
    }
  }

  function bindDenyTarget(normalized: string, kind: "read" | "write"): void {
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
    if (isDirectoryForDeny(normalized)) {
      addMount("tmpfs", "", normalized);
      return;
    }

    // Without its cover a denied file stays readable, so a launch that cannot
    // make one is refused rather than started with the file exposed.
    const source = createEmptySourceForPath(normalized);
    if (source === undefined) {
      throw new ProcessConfinementError(
        "invalid-configuration",
        `Linux confinement deny ${kind} path "${normalized}" could not be overlaid.`,
      );
    }
    addMount("ro-bind", source, normalized);
  }

  for (const path of input.additionalDenyWritePaths ?? []) {
    bindAdditionalDenyPath(path, "write");
  }

  for (const path of input.additionalDenyReadPaths ?? []) {
    bindAdditionalDenyPath(path, "read");
  }
  for (const path of hostSecretPaths()) {
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
  if (forwarder !== undefined && proxied?.endpoint.kind === "unix-socket") {
    // A packaged host's runtime is Electron, which runs a script only as Node.
    if (process.versions.electron !== undefined) {
      args.push("--setenv", "ELECTRON_RUN_AS_NODE", "1");
    }
    // The forwarder inherits the command's `NODE_USE_ENV_PROXY=1`, and a Node
    // 22 runtime answers that at startup with an experimental-feature warning
    // on stderr, which is the command's stderr: every proxied command's output
    // then carried it. The forwarder writes its own refusals directly, so it
    // needs no runtime warnings at all; the command's environment is unchanged.
    args.push(
      "--",
      forwarder.runtime,
      "--no-warnings",
      forwarder.script,
      proxied.endpoint.path,
      String(LINUX_EGRESS_FORWARDER_PORT),
      input.executable,
    );
  } else {
    args.push("--", input.executable);
  }
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

/**
 * Credentials under the bound `/etc` that no confined workload reads. Their
 * owner bits let a root host's capsule read them even without capabilities,
 * so each is covered like a read denial. The rest of `/etc` stays bound:
 * resolvers, TLS roots, `passwd`, the dynamic linker cache, `alternatives`
 * links, and login shell startup files are all read from it.
 */
const HOST_SECRET_PATHS: ReadonlyArray<string> = [
  "/etc/shadow",
  "/etc/shadow-",
  "/etc/gshadow",
  "/etc/gshadow-",
  "/etc/security/opasswd",
  "/etc/ssl/private",
];

function hostSecretPaths(): ReadonlyArray<string> {
  let sshEntries: ReadonlyArray<string> = [];
  try {
    sshEntries = readdirSync("/etc/ssh");
  } catch {
    // No SSH server configuration on this host.
  }
  const sshHostKeys = sshEntries
    .filter((name) => /^ssh_host_.+_key$/.test(name))
    .map((name) => join("/etc/ssh", name));
  // Bubblewrap would have to create a missing path's mount point inside the
  // read-only `/etc` bind, which fails the launch; a missing path hides
  // nothing anyway. A linked one is covered at its target, like every other
  // denial (see `denyTargetsInCapsule`).
  return [...HOST_SECRET_PATHS, ...sshHostKeys].filter((path) => pathExists(path));
}

/**
 * Where the capsule reaches what a host deny path names.
 *
 * Bubblewrap follows an absolute link at a mount point from outside the new
 * root: measured on bwrap 0.9.0, a denied `.claude/skills` or host key linked
 * to another folder refused the whole launch with "Can't create file at".
 * A path that passes through a link inside bound content is therefore covered
 * at its target instead, found through the mount that exposes it. Binds keep
 * the path the launch names and take their resolved folder as the source, so
 * the target is mapped back from that source rather than used as a host path:
 * a bound root named through a link still has its files denied under the name
 * the capsule sees. A target no mount exposes is unreachable and needs no
 * cover. A missing path keeps its name so it stays hidden if created later,
 * and a dangling link names nothing to hide.
 */
function denyTargetsInCapsule(
  path: string,
  mounts: ReadonlyMap<string, Mount>,
): ReadonlyArray<string> {
  if (!pathExists(path)) return [path];
  const resolved = safeRealpathSync(path);
  if (resolved === undefined) return [];
  if (resolved === path) return [path];
  // Above every bind the capsule holds only the folders Bubblewrap made for
  // its mount points, so a link there on the host is no link in the capsule.
  const exposing = mountExposing(path, mounts);
  if (exposing === undefined || exposing.kind === "tmpfs" || exposing.kind === "tmpfs-rw") {
    return [path];
  }
  return [...mounts.values()].flatMap((mount) => {
    if (mount.kind !== "bind" && mount.kind !== "ro-bind") return [];
    if (resolved !== mount.source && !resolved.startsWith(`${mount.source}${sep}`)) return [];
    const target = join(mount.target, relative(mount.source, resolved));
    // A deeper mount over the same place shows something else there.
    return mountExposing(target, mounts) === mount ? [target] : [];
  });
}

function mountExposing(path: string, mounts: ReadonlyMap<string, Mount>): Mount | undefined {
  let deepest: Mount | undefined;
  for (const mount of mounts.values()) {
    if (path !== mount.target && !path.startsWith(`${mount.target}${sep}`)) continue;
    if (deepest === undefined || depth(mount.target) > depth(deepest.target)) deepest = mount;
  }
  return deepest;
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
    throw new ProcessConfinementError(
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
        throw new ProcessConfinementError(
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
  throw new ProcessConfinementError(
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
    throw new ProcessConfinementError(
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

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
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

function createEmptySourceForPath(path: string): string | undefined {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() && !stats.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  return emptyDenySource();
}

let reusedEmptyDenySource: string | undefined;

/**
 * The empty file every denied file is covered with. It lives under the host
 * temp directory for the server's lifetime, where a cleaner such as
 * systemd-tmpfiles may delete it; Bubblewrap then refused every later launch
 * with "Can't find source path" until the server restarted. So it is checked
 * before each use and made again when it is gone or no longer empty.
 */
function emptyDenySource(): string | undefined {
  if (reusedEmptyDenySource !== undefined) {
    try {
      const stats = lstatSync(reusedEmptyDenySource);
      if (stats.isFile() && stats.size === 0) return reusedEmptyDenySource;
    } catch {
      // Removed since the last launch; make another below.
    }
  }
  try {
    const file = join(mkdtempSync(join(tmpdir(), "octant-deny-")), "file");
    writeFileSync(file, "");
    reusedEmptyDenySource = file;
    return file;
  } catch {
    return undefined;
  }
}
