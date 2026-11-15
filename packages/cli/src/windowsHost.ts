import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { win32 } from "node:path";
import {
  attachWindowsHostRuntimeOwner,
  createWindowsHostStartup,
  loadWindowsHostProfileNative,
  resolveWindowsHostProfile,
  type HostRuntimeAttachment,
  type WindowsHostProfileNative,
  type WindowsHostProfilePaths,
} from "@octant/host-runtime";
import type { HostLifecycleControl } from "./serverLifecycle";
import { resolveServerStartCommand } from "./serverRun";
import {
  createWindowsUserServiceManager,
  resolveCurrentCliEntryPoint,
  type ServiceCommandRunner,
  type UserServiceManager,
  type WindowsHostObservation,
  type WindowsHostOwnerPort,
} from "./serviceManager";
import {
  buildWebClientUrl,
  createLaunchSession,
  generateWindowCapability,
  generateWindowId,
} from "./hostLauncher";

const NATIVE_HOST_OWNER_FILENAME = "octant-windows-host-owner.node";

/**
 * Octant's own Windows host as the native profile names it. The folders
 * (`%LOCALAPPDATA%\Octant\hosts\octant\{data,config,state,logs}`) come from
 * the native known-folder lookup the desktop app and the server use, never
 * from an environment string, so the CLI and the app share one host.
 */
export interface WindowsCliHost {
  readonly native: WindowsHostProfileNative;
  readonly paths: WindowsHostProfilePaths;
  readonly startup: NonNullable<ReturnType<typeof createWindowsHostStartup>>;
}

export type WindowsCliHostResolution =
  | ({ readonly status: "ready" } & WindowsCliHost)
  | { readonly status: "refused"; readonly message: string };

/**
 * The native binding the server this CLI starts loads: four folders above the
 * module, as the server's own entry resolves it (`resources/native` beside
 * `resources/app/apps/server` and `resources/app/packages/cli`).
 */
export function windowsNativeHostOwnerPath(moduleDirectory: string): string {
  return win32.resolve(
    moduleDirectory,
    "..",
    "..",
    "..",
    "..",
    "native",
    NATIVE_HOST_OWNER_FILENAME,
  );
}

export function openWindowsCliHost(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly native?: WindowsHostProfileNative | undefined;
}): WindowsCliHostResolution {
  const native =
    input.native ??
    loadWindowsHostProfileNative(
      windowsNativeHostOwnerPath(win32.dirname(fileURLToPath(import.meta.url))),
    );
  if (native === undefined)
    return {
      status: "refused",
      message: "Octant's native Windows host binding is not installed beside this command.",
    };
  const resolved = resolveWindowsHostProfile({ native, profile: "octant", env: input.env });
  if (resolved.status !== "ready")
    return {
      status: "refused",
      message:
        resolved.reason === "path-override"
          ? "OCTANT_DATA_DIR and OCTANT_LOGS_DIR are not supported on Windows; Octant keeps its host in your local application data folder."
          : // The native check refuses a token whose default owner is not the
            // user (an elevated prompt's is Administrators); it is never bypassed.
            "Octant could not open its private Windows profile. It refuses to create or open it from an elevated (Run as administrator) prompt; run this command from an ordinary one.",
    };
  const startup = createWindowsHostStartup(native, resolved.paths);
  if (startup === undefined)
    return {
      status: "refused",
      message: "Octant's private Windows startup files are unavailable.",
    };
  return { status: "ready", native, paths: resolved.paths, startup };
}

const UNANSWERED_ATTEMPTS = 3;
const UNANSWERED_PAUSE_MS = 250;

type WindowsOwnerLookup =
  | { readonly status: "attached"; readonly attachment: HostRuntimeAttachment }
  | { readonly status: "missing" }
  | { readonly status: "refused" };

/** Native lookup and authentication; an unanswered pipe is looked up again a bounded number of times. */
async function lookUpOwner(
  host: Pick<WindowsCliHost, "native" | "paths">,
): Promise<WindowsOwnerLookup> {
  const attach = () =>
    attachWindowsHostRuntimeOwner({
      native: host.native,
      scope: host.paths.profileId,
      hostId: host.paths.profileId,
      wireVersion: "1",
    });
  let found = await attach();
  for (
    let attempt = 1;
    attempt < UNANSWERED_ATTEMPTS && found.status === "refused" && found.reason === "unanswered";
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, UNANSWERED_PAUSE_MS));
    found = await attach();
  }
  if (found.status === "attached") return found;
  return found.status === "missing" ? found : { status: "refused" };
}

export function createWindowsHostOwnerPort(
  host: Pick<WindowsCliHost, "native" | "paths">,
): WindowsHostOwnerPort {
  return {
    observe: async (): Promise<WindowsHostObservation> => {
      const found = await lookUpOwner(host);
      if (found.status === "missing") return { status: "absent" };
      if (found.status === "refused") return { status: "unanswered" };
      return { status: "running", pid: found.attachment.owner.pid };
    },
    requestStop: async () => {
      const found = await lookUpOwner(host);
      return found.status === "attached" && (await found.attachment.requestStop());
    },
  };
}

/** The lifecycle command's owner control over the native pipe instead of a Unix socket. */
export function createWindowsHostLifecycleControl(
  host: Pick<WindowsCliHost, "native" | "paths">,
): HostLifecycleControl {
  return {
    request: async (request) => {
      const found = await lookUpOwner(host);
      return found.status === "attached" ? await found.attachment.request(request) : undefined;
    },
    proveNoOwner: async () => (await lookUpOwner(host)).status === "missing",
  };
}

export function createWindowsCliServiceManager(
  host: WindowsCliHost,
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly runner?: ServiceCommandRunner;
  },
): UserServiceManager {
  return createWindowsUserServiceManager({
    systemRoot: options.env.SystemRoot ?? "C:\\Windows",
    logonCommand: [process.execPath, resolveCurrentCliEntryPoint(), "server", "start"],
    host: () => windowsHostLaunch(options.env),
    owner: createWindowsHostOwnerPort(host),
    logs: (readOptions) => host.startup.logs.read(readOptions),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
}

/** The server entry with a fresh instance and bridge secret, marked as the service host. */
export function windowsHostLaunch(env: Readonly<Record<string, string | undefined>>) {
  const command = resolveServerStartCommand();
  const childEnv: Record<string, string | undefined> = { ...env, ...command.env };
  for (const key of ["OCTANT_CREDENTIAL_BROKER_URL", "OCTANT_CREDENTIAL_BROKER_TOKEN"])
    delete childEnv[key];
  Object.assign(childEnv, {
    OCTANT_HOST_SERVICE_MODE: "service",
    OCTANT_SERVER_INSTANCE_ID: randomUUID(),
    OCTANT_DESKTOP_BRIDGE_SECRET: randomBytes(32).toString("base64url"),
  });
  return { command: command.command, args: command.args, env: childEnv };
}

export type WindowsWebOutcome =
  | { readonly kind: "opened"; readonly url: URL }
  | { readonly kind: "served"; readonly url: URL }
  | { readonly kind: "start-failed"; readonly reason: string }
  | { readonly kind: "auth-failed"; readonly reason: string };

/**
 * `octant web` on Windows attaches to the running host only. The bridge
 * secret goes to the URL the native host-info projection names, and only
 * when that projection belongs to the owner the native pipe authenticated.
 */
export async function runWindowsWebCommand(options: {
  readonly host: WindowsCliHost;
  readonly noOpen: boolean;
  readonly openBrowser: (url: URL) => Promise<void>;
  readonly stdout: { write: (chunk: string) => unknown };
  readonly stderr: { write: (chunk: string) => unknown };
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
}): Promise<WindowsWebOutcome> {
  const found = await lookUpOwner(options.host);
  if (found.status !== "attached") {
    const reason =
      found.status === "missing"
        ? "Octant is not running on this computer. Start it with `octant server start`, then run this command again."
        : "Octant could not authenticate its Windows host.";
    options.stderr.write(`${reason}\n`);
    return { kind: "start-failed", reason };
  }
  const owner = found.attachment.owner;
  const receipt = await options.host.startup.readHostInfo();
  const bridgeSecret = await options.host.startup.readBridgeSecret();
  if (
    receipt === undefined ||
    bridgeSecret === undefined ||
    receipt.instanceId !== owner.instanceId ||
    receipt.controlEndpoint !== owner.endpoint
  ) {
    const reason =
      "Octant's Windows host has not published its address for this user yet. Wait for `octant server status` to report ready, then run this command again.";
    options.stderr.write(`${reason}\n`);
    return { kind: "auth-failed", reason };
  }
  const serverUrl = new URL(receipt.url);
  const session = await createLaunchSession({
    bridgeSecret,
    serverUrl,
    windowId: generateWindowId(),
    capability: generateWindowCapability(),
    origin: serverUrl.origin,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (session === undefined) {
    const reason = "The Octant host refused to create a browser launch link.";
    options.stderr.write(`${reason}\n`);
    return { kind: "auth-failed", reason };
  }
  const url = buildWebClientUrl({ serverUrl, launchToken: session.launchToken });
  if (options.noOpen) {
    options.stdout.write(`Octant web client ready at ${url.toString()}\n`);
    return { kind: "served", url };
  }
  try {
    await options.openBrowser(url);
  } catch {
    options.stdout.write(
      `Octant could not open a browser automatically. Open this URL manually: ${url.toString()}\n`,
    );
  }
  options.stdout.write(`Octant web client opened at ${serverUrl.toString()}\n`);
  return { kind: "opened", url };
}
