import {
  isSameOrInside,
  protectedEntryFor,
  type ResolvedProtectedEntry,
  windowsGuardPath,
} from "./secretGuardPolicy";

/**
 * The Windows form of a confined launch: what one AppContainer, its file
 * grants and its job object hold, decided from the same facts the Seatbelt
 * profile and the Bubblewrap capsule are built from. The host turns the plan
 * into arguments for the fixed native launcher, which is the only code that
 * touches tokens, ACLs and jobs. Nothing here reads the disk.
 *
 * An AppContainer is deny-by-default: its SID reaches only objects whose DACL
 * names it (or ALL APPLICATION PACKAGES, which system folders carry and the
 * person's profile does not). So the secret guard holds as an OS rule by
 * never granting at, inside or above a protected location, and by an
 * refusing a launch whose grant already holds a pattern match. No deny entry
 * is relied on: on Windows Server 2025 an explicit access-denied entry for
 * the container's SID, listed ahead of its inherited grant, did not stop the
 * container reading the file, for a reason not yet established.
 */

/** `read` also lets the container list folders and run programs in them; `modify` adds write and delete. */
export type WindowsConfinementAccess = "read" | "modify";

export interface WindowsConfinementGrant {
  /** Drive-absolute, backslashed, no trailing separator. */
  readonly path: string;
  readonly access: WindowsConfinementAccess;
}

/**
 * A pattern entry whose folder holds a grant with levels of the pattern left
 * beneath it. The host walks `directory` that many levels and refuses the
 * launch when it finds a match or cannot finish the walk.
 */
export interface WindowsConfinementPatternScan {
  readonly directory: string;
  readonly levels: number;
  readonly entry: ResolvedProtectedEntry & { readonly kind: "names" };
}

/**
 * `none`: no capability, so no socket reaches anything. `allow`: the internet
 * and private-network client capabilities; the host's own loopback stays
 * unreachable, because an AppContainer is loopback-isolated. `proxied` has no
 * Windows form yet and is refused (see the plan's refusal).
 */
export type WindowsConfinementNetwork = "none" | "allow" | "proxied";

export const WINDOWS_CONFINEMENT_CAPABILITIES = {
  none: [],
  allow: ["internetClient", "privateNetworkClientServer"],
} as const satisfies Record<"none" | "allow", ReadonlyArray<string>>;

export type WindowsConfinementCapability =
  (typeof WINDOWS_CONFINEMENT_CAPABILITIES)["allow"][number];

export interface WindowsConfinementInput {
  /** 32 lowercase hex characters, fresh per launch: the AppContainer profile's name. */
  readonly launchId: string;
  readonly executable: string;
  readonly boundRoot: string;
  readonly extraBoundRoots: ReadonlyArray<string>;
  readonly writeBoundRoot: boolean;
  readonly temporaryDirectory: string;
  readonly additionalWriteRoots: ReadonlyArray<string>;
  readonly readRoots: ReadonlyArray<string>;
  readonly network: WindowsConfinementNetwork;
  /** `denied` for a launch that may neither fork nor exec (Plan, Chat). */
  readonly processCreation: "allowed" | "denied";
  /** The secret guard's list for this launch, Windows entries in guard form. */
  readonly protectedEntries: ReadonlyArray<ResolvedProtectedEntry>;
  /** The launching runtime's own sign-in locations, exempt only from sign-in entries. */
  readonly ownAccountPaths: ReadonlyArray<string>;
}

export type WindowsConfinementRefusal =
  | "invalid-launch-id"
  | "unspelled-path"
  | "drive-root"
  | "not-an-executable"
  | "proxied-network"
  | "covers-protected";

export type WindowsConfinementDecision =
  | {
      readonly status: "planned";
      readonly appContainerName: string;
      readonly capabilities: ReadonlyArray<WindowsConfinementCapability>;
      readonly grants: ReadonlyArray<WindowsConfinementGrant>;
      readonly patternScans: ReadonlyArray<WindowsConfinementPatternScan>;
      /** 1 when the launch may create no process; absent leaves the count open. */
      readonly activeProcessLimit?: 1;
      readonly workingDirectory: string;
      readonly executable: string;
    }
  | {
      readonly status: "refused";
      readonly refusal: WindowsConfinementRefusal;
      readonly message: string;
    };

const LAUNCH_ID = /^[0-9a-f]{32}$/u;

export function planWindowsConfinedLaunch(
  input: WindowsConfinementInput,
): WindowsConfinementDecision {
  if (!LAUNCH_ID.test(input.launchId)) {
    return refused(
      "invalid-launch-id",
      "A Windows confined launch needs a fresh 32-hex launch id.",
    );
  }
  // A proxied launch reaches the host's egress proxy on loopback. An
  // AppContainer cannot reach the host's loopback unless an administrator
  // exempts the container, so the proxy-only boundary has no Windows form
  // and the launch is refused rather than widened to open network.
  if (input.network === "proxied") {
    return refused(
      "proxied-network",
      "Windows confinement has no proxied network: an AppContainer cannot reach the host's egress proxy on loopback without an administrator's exemption.",
    );
  }
  const executable = windowsNativePath(input.executable);
  if (executable === undefined) return unspelled("executable");
  // CreateProcess runs only a PE image; a `.cmd` shim or a script needs an
  // interpreter chosen on purpose, which the Windows launches step decides.
  if (!/\.exe$/iu.test(executable)) {
    return refused(
      "not-an-executable",
      "Windows confinement starts only a .exe program; a script or .cmd shim is not launched.",
    );
  }
  const requested: Array<{ path: string; access: WindowsConfinementAccess; fresh: boolean }> = [];
  const boundAccess: WindowsConfinementAccess = input.writeBoundRoot ? "modify" : "read";
  for (const root of [input.boundRoot, ...input.extraBoundRoots]) {
    const path = windowsNativePath(root);
    if (path === undefined) return unspelled("bound root");
    requested.push({ path, access: boundAccess, fresh: false });
  }
  const temporary = windowsNativePath(input.temporaryDirectory);
  if (temporary === undefined) return unspelled("temporary directory");
  requested.push({ path: temporary, access: "modify", fresh: true });
  for (const root of input.additionalWriteRoots) {
    const path = windowsNativePath(root);
    if (path === undefined) return unspelled("write root");
    requested.push({ path, access: "modify", fresh: true });
  }
  for (const root of input.readRoots) {
    const path = windowsNativePath(root);
    if (path === undefined) return unspelled("read root");
    requested.push({ path, access: "read", fresh: false });
  }
  requested.push({ path: windowsParent(executable), access: "read", fresh: false });

  for (const grant of requested) {
    // An inheritable ACE on a drive root would be written over every file on
    // the drive, and grants everything the guard protects beneath it.
    if (/^[A-Za-z]:$/u.test(grant.path)) {
      return refused(
        "drive-root",
        `Windows confinement does not grant a whole drive (${grant.path}\\).`,
      );
    }
  }

  const own = input.ownAccountPaths
    .map((path) => windowsGuardPath(path))
    .filter((path): path is string => path !== undefined);
  const patternScans: WindowsConfinementPatternScan[] = [];
  for (const grant of requested) {
    const form = guardForm(grant.path);
    for (const entry of input.protectedEntries) {
      const exempt = entry.ownAccountExempt && own.some((owned) => isSameOrInside(form, owned));
      if (entry.kind === "path") {
        // Above the entry: the inheritable ACE would reach it. At or inside:
        // the grant names it. Only a runtime's own account home is exempt,
        // and only from inside it.
        if (isSameOrInside(entry.path, form) && entry.path !== form) {
          return coversProtected(grant.path, entry);
        }
        if (isSameOrInside(form, entry.path) && !exempt) return coversProtected(grant.path, entry);
        continue;
      }
      if (isSameOrInside(entry.directory, form)) return coversProtected(grant.path, entry);
      if (!isSameOrInside(form, entry.directory) || exempt) continue;
      // The grant itself, or a folder on its way down, may be the store: a
      // read root naming a `Cookies` file sits at the pattern's last level, so
      // no scan below it would ever look at it.
      const segments = form.slice(entry.directory.length + 1).split("/");
      for (let length = 1; length <= segments.length; length += 1) {
        const prefix = `${entry.directory}/${segments.slice(0, length).join("/")}`;
        if (protectedEntryFor([prefix], [entry]) !== undefined) {
          return coversProtected(grant.path, entry);
        }
      }
      const depthBelow = segments.length;
      const levels = entry.depth - depthBelow;
      if (levels > 0) patternScans.push({ directory: grant.path, levels, entry });
    }
  }

  const grants = strongestGrants(requested);
  const capabilities: ReadonlyArray<WindowsConfinementCapability> =
    WINDOWS_CONFINEMENT_CAPABILITIES[input.network];
  const workingDirectory = windowsNativePath(input.boundRoot) ?? temporary;
  return {
    status: "planned",
    appContainerName: `Octant.Confined.${input.launchId}`,
    capabilities,
    grants,
    patternScans,
    ...(input.processCreation === "denied" ? { activeProcessLimit: 1 as const } : {}),
    workingDirectory,
    executable,
  };
}

/** The native launcher's arguments for a planned launch. */
export function windowsConfinedLauncherArguments(
  plan: Extract<WindowsConfinementDecision, { readonly status: "planned" }>,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    "--container",
    plan.appContainerName,
    ...plan.capabilities.flatMap((capability) => ["--capability", capability]),
    ...plan.grants.flatMap((grant) => [`--grant-${grant.access}`, grant.path]),
    ...(plan.activeProcessLimit === undefined
      ? []
      : ["--active-process-limit", String(plan.activeProcessLimit)]),
    "--cwd",
    plan.workingDirectory,
    "--",
    plan.executable,
    ...args,
  ];
}

/**
 * Full access is full access on Windows too: no AppContainer, no grants and
 * no network rule. Its Windows form is the job object alone, so stopping the
 * launch ends every process it started, which process groups do elsewhere.
 */
export function windowsFullAccessLauncherArguments(input: {
  readonly executable: string;
  readonly workingDirectory: string;
  readonly args: ReadonlyArray<string>;
}): ReadonlyArray<string> | undefined {
  const executable = windowsNativePath(input.executable);
  const workingDirectory = windowsNativePath(input.workingDirectory);
  if (executable === undefined || workingDirectory === undefined) return undefined;
  return ["--full-access", "--cwd", workingDirectory, "--", executable, ...input.args];
}

/**
 * A drive-absolute path in the one spelling the launcher and the guard agree
 * on: backslashes, no trailing separator, and no segment Windows would
 * rewrite before opening (`.`, `..`, a trailing dot or space, a stream
 * `name:x`, an 8.3 short name). Anything else, a share or device path included, is undefined and
 * refused: the guard cannot judge what it cannot spell.
 */
export function windowsNativePath(path: string): string | undefined {
  if (!/^[A-Za-z]:[\\/]/u.test(path)) return undefined;
  const segments = path
    .slice(3)
    .split(/[\\/]/u)
    .filter((segment) => segment !== "");
  for (const segment of segments) {
    if (segment === "." || segment === "..") return undefined;
    if (segment.includes(":") || /[. ]$/u.test(segment)) return undefined;
    if (/[<>"|?*]/u.test(segment)) return undefined;
    if ([...segment].some((character) => character.charCodeAt(0) < 0x20)) return undefined;
    // An 8.3 short name (`RUNNER~1`) opens the same folder as its long name,
    // which the guard's entries never spell; the host passes long names.
    if (/^[^.~]{1,6}~\d{1,6}(?:\.[^.]{1,3})?$/u.test(segment)) return undefined;
  }
  const drive = path.slice(0, 2).toUpperCase();
  return segments.length === 0 ? drive : `${drive}\\${segments.join("\\")}`;
}

function windowsParent(path: string): string {
  const index = path.lastIndexOf("\\");
  return index <= 2 ? path.slice(0, 2) : path.slice(0, index);
}

function guardForm(nativePath: string): string {
  return windowsGuardPath(/^[A-Za-z]:$/u.test(nativePath) ? `${nativePath}\\` : nativePath) ?? "";
}

/** One grant per folder (by its case-folded form), keeping `modify` over `read`. */
function strongestGrants(
  requested: ReadonlyArray<{ readonly path: string; readonly access: WindowsConfinementAccess }>,
): ReadonlyArray<WindowsConfinementGrant> {
  const byForm = new Map<string, WindowsConfinementGrant>();
  for (const grant of requested) {
    const form = guardForm(grant.path);
    const existing = byForm.get(form);
    if (existing === undefined || (existing.access === "read" && grant.access === "modify")) {
      byForm.set(form, { path: existing?.path ?? grant.path, access: grant.access });
    }
  }
  return [...byForm.values()];
}

function refused(
  refusal: WindowsConfinementRefusal,
  message: string,
): WindowsConfinementDecision & { readonly status: "refused" } {
  return { status: "refused", refusal, message };
}

function unspelled(label: string): WindowsConfinementDecision {
  return refused(
    "unspelled-path",
    `Windows confinement needs a drive-absolute ${label} such as C:\\Users\\you\\project; a share, device, relative or rewritten path is refused.`,
  );
}

function coversProtected(path: string, entry: ResolvedProtectedEntry): WindowsConfinementDecision {
  return refused(
    "covers-protected",
    `Windows confinement does not grant ${path}: it would reach ${entry.label}, which the secret guard protects.`,
  );
}
