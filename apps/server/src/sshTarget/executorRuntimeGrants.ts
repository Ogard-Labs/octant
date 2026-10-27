import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type {
  SshPlacedAccountState,
  SshPlacedProcessRefusalReason,
} from "@octant/contracts/ssh-executor-protocol";
import type { SshConfinedPosture } from "@octant/contracts/ssh-target";
import type { ProcessConfinementPrepareInput } from "../process/seatbeltProfile";
import type { OsNetworkEgress } from "../process/threadEgressPolicy";
import { postureGrants } from "./executorAttestation";

/**
 * What a provider runtime placed on an SSH target is granted beyond a
 * command, and the checks each grant passes on the target before a launch.
 * Canonical: docs/design/remote-ssh-environments.md § Runtime placement (R2).
 *
 * A placed runtime gets its posture's command grants with three differences,
 * as a wrapped runtime gets on this host: its own home, the only place it
 * writes outside the bound root; its binary's folder, read-only; and the
 * account-state paths its driver declares, under the remote user's home.
 * Every one is the remote user's own, checked for links and for who else can
 * write it, and none may reach the remote user's `~/.ssh`, the bound root, or
 * the executor's own folders. The grant is always the resolved folder, so a
 * link swapped in after the check points at nothing granted.
 */

/** The folder under the remote user's state directory that holds every runtime home. */
export const RUNTIME_HOMES_FOLDER = "octant-runtime-homes";

export interface ExecutorRuntimeGrantEnvironment {
  readonly uid: number;
  readonly homeDirectory: string;
  /** `XDG_STATE_HOME` as the executor's environment names it; unset means `~/.local/state`. */
  readonly stateHome: string | undefined;
  /** The per-user parent of every executor session directory. */
  readonly sessionParent: string | undefined;
}

export type RuntimeGrantCheck<T> =
  | { readonly status: "granted"; readonly value: T }
  | { readonly status: "refused"; readonly reason: SshPlacedProcessRefusalReason };

function refused<T>(reason: SshPlacedProcessRefusalReason): RuntimeGrantCheck<T> {
  return { status: "refused", reason };
}

/** Where every runtime home of this user lives on the target. */
export function runtimeHomesRoot(environment: ExecutorRuntimeGrantEnvironment): string {
  const stateHome =
    environment.stateHome !== undefined && isAbsolute(environment.stateHome)
      ? environment.stateHome
      : join(environment.homeDirectory, ".local", "state");
  return join(stateHome, RUNTIME_HOMES_FOLDER);
}

/** Whether `path` is `folder` or lies inside it. */
function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

/** Whether two folders overlap: one is, holds, or sits inside the other. */
function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The folders no runtime grant may reach: the remote user's keys, the bound
 * root (outside the root's own grant), and the executor's own folders.
 */
function forbiddenFolders(
  environment: ExecutorRuntimeGrantEnvironment,
  root: string,
): ReadonlyArray<string> {
  return [
    canonical(join(environment.homeDirectory, ".ssh")),
    root,
    ...(environment.sessionParent === undefined ? [] : [canonical(environment.sessionParent)]),
    canonical(runtimeHomesRoot(environment)),
  ];
}

/**
 * A folder that must be this user's own and private: a real directory, not a
 * link, owned by the remote user, that no one else can enter.
 */
function privateFolder(path: string, uid: number): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && stats.uid === uid && (stats.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function makePrivateFolder(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * The runtime's home: one owner-only folder per Project and provider
 * instance, kept across sessions so a provider can resume its own session
 * files, never deleted by Octant. A folder on the way that is a link, is
 * another user's, or that others can enter is refused rather than used.
 */
export function openRuntimeHome(
  environment: ExecutorRuntimeGrantEnvironment,
  root: string,
  home: { readonly project: string; readonly instance: string },
): RuntimeGrantCheck<string> {
  const homes = runtimeHomesRoot(environment);
  const project = join(homes, home.project);
  const instance = join(project, home.instance);
  try {
    mkdirSync(dirname(homes), { recursive: true, mode: 0o700 });
    for (const folder of [homes, project, instance]) {
      makePrivateFolder(folder);
      if (!privateFolder(folder, environment.uid)) return refused("runtime-home-not-confinable");
    }
  } catch {
    return refused("runtime-home-not-confinable");
  }
  const resolved = canonical(instance);
  const sshDirectory = canonical(join(environment.homeDirectory, ".ssh"));
  if (
    overlaps(resolved, root) ||
    overlaps(resolved, sshDirectory) ||
    (environment.sessionParent !== undefined &&
      overlaps(resolved, canonical(environment.sessionParent)))
  ) {
    return refused("runtime-home-not-confinable");
  }
  return { status: "granted", value: resolved };
}

export interface RuntimeBinary {
  /** The binary's resolved path, which is what launches. */
  readonly path: string;
  /** Folders the runtime may read beside it: its own, and its parent when that reaches nothing forbidden. */
  readonly readFolders: ReadonlyArray<string>;
}

/**
 * The runtime's binary: a regular executable file, outside the bound root,
 * the remote user's keys, and the executor's folders, in a folder only the
 * remote user or root can write, under folders that are theirs too (a
 * world-writable folder above counts only with its sticky bit). Otherwise the
 * repository, or another user, would choose what runs.
 */
export function checkRuntimeBinary(
  environment: ExecutorRuntimeGrantEnvironment,
  root: string,
  executable: string,
): RuntimeGrantCheck<RuntimeBinary> {
  let path: string;
  try {
    path = realpathSync(executable);
    if (!lstatSync(path).isFile()) return refused("runtime-binary-not-confinable");
    accessSync(path, constants.X_OK);
  } catch {
    return refused("runtime-binary-not-confinable");
  }
  const owners = new Set([environment.uid, 0]);
  const folder = dirname(path);
  const forbidden = forbiddenFolders(environment, root);
  if (forbidden.some((candidate) => overlaps(folder, candidate) || within(path, candidate))) {
    return refused("runtime-binary-not-confinable");
  }
  try {
    for (const [index, entry] of [path, ...ancestors(folder)].entries()) {
      const stats = statSync(entry);
      if (!owners.has(stats.uid)) return refused("runtime-binary-not-confinable");
      const othersWrite = (stats.mode & 0o022) !== 0;
      // The binary and its own folder must be writable by no one else; a
      // folder above may be shared only when its sticky bit keeps others from
      // renaming what they do not own.
      if (othersWrite && (index <= 1 || (stats.mode & 0o1000) === 0)) {
        return refused("runtime-binary-not-confinable");
      }
    }
  } catch {
    return refused("runtime-binary-not-confinable");
  }
  const parent = dirname(folder);
  // The binary's folder is resolved, so the home is compared resolved too: a
  // home reached through a link would otherwise not match its own real path.
  const parentReachesForbidden =
    parent === folder ||
    parent === "/" ||
    within(canonical(environment.homeDirectory), parent) ||
    forbidden.some((candidate) => overlaps(parent, candidate));
  return {
    status: "granted",
    value: { path, readFolders: parentReachesForbidden ? [folder] : [folder, parent] },
  };
}

/** `folder` and every folder above it, nearest first. */
function ancestors(folder: string): ReadonlyArray<string> {
  const chain = [folder];
  let current = folder;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return chain;
    chain.push(parent);
    current = parent;
  }
}

export interface RuntimeAccountState {
  readonly readPaths: ReadonlyArray<string>;
  readonly writePaths: ReadonlyArray<string>;
  /** The variables that point the runtime at its paths, set here on the target. */
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * The account-state paths the driver declared, each at the same place under
 * the remote user's home as under this host's. Each must exist, be the remote
 * user's own, resolve inside the home, and neither be, hold, nor sit inside
 * the remote user's keys, the bound root, or the executor's folders.
 */
export function checkAccountState(
  environment: ExecutorRuntimeGrantEnvironment,
  root: string,
  entries: ReadonlyArray<SshPlacedAccountState>,
): RuntimeGrantCheck<RuntimeAccountState> {
  const home = canonical(environment.homeDirectory);
  const forbidden = forbiddenFolders(environment, root);
  const readPaths: string[] = [];
  const writePaths: string[] = [];
  const variables: Record<string, string> = {};
  for (const entry of entries) {
    let resolved: string;
    try {
      resolved = realpathSync(join(environment.homeDirectory, entry.path));
      if (statSync(resolved).uid !== environment.uid) {
        return refused("account-state-not-confinable");
      }
    } catch {
      return refused("account-state-not-confinable");
    }
    if (
      resolved === home ||
      !within(resolved, home) ||
      forbidden.some((candidate) => overlaps(resolved, candidate))
    ) {
      return refused("account-state-not-confinable");
    }
    readPaths.push(resolved);
    if (entry.access === "read-write") writePaths.push(resolved);
    if (entry.variable !== undefined) {
      if (Object.hasOwn(variables, entry.variable)) return refused("account-state-not-confinable");
      variables[entry.variable] = resolved;
    }
  }
  return { status: "granted", value: { readPaths, writePaths, environment: variables } };
}

/**
 * The confinement a placed runtime launches with: its posture's command
 * grants, its home writable, its binary's folders and its account state
 * readable, and the account state it may write writable. The canaries prove
 * this same shape against a scratch home and account state.
 */
export function runtimeLaunchGrants(input: {
  readonly posture: SshConfinedPosture;
  readonly root: string;
  readonly home: string;
  readonly temporaryDirectory: string;
  readonly binaryFolders: ReadonlyArray<string>;
  readonly accountState: Pick<RuntimeAccountState, "readPaths" | "writePaths">;
  readonly networkEgress: OsNetworkEgress;
}): Omit<ProcessConfinementPrepareInput, "executable" | "args"> {
  const readable = [input.root, input.home, ...input.accountState.readPaths];
  return {
    boundRoot: input.root,
    temporaryDirectory: input.temporaryDirectory,
    networkEgress: input.networkEgress,
    ...postureGrants(input.posture),
    additionalWriteRoots: [input.home, ...input.accountState.writePaths],
    allowFileReadStar: true,
    readRoots: [...readable, ...input.binaryFolders, input.temporaryDirectory],
    // The remote user's home is not among them, so `~/.ssh` is not in the
    // capsule at all; a deny cover would only mount an empty folder there.
    privateHomeAllowPaths: [...readable, ...input.binaryFolders],
  };
}
