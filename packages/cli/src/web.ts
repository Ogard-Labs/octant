import type { WindowId } from "@octant/contracts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachOrCreateHost,
  buildWebClientUrl,
  createDefaultServicePolicyStore,
  createLaunchSession,
  type HostLauncherResult,
  type HostServicePolicyReader,
} from "./hostLauncher";
import {
  readBridgeSecretFile,
  readHostInfoFile,
  type BridgeSecretFileInput,
  type HostInfo,
} from "./bridgeSecretFile";

export interface WebCommandOptions {
  readonly bridgeSecret?: string | undefined;
  readonly hostname?: string | undefined;
  readonly port?: number | undefined;
  readonly noOpen?: boolean;
  readonly dev?: boolean;
  readonly attachOrCreateHost?: typeof attachOrCreateHost;
  readonly createLaunchSession?: typeof createLaunchSession;
  readonly openBrowser?: (url: URL) => void | Promise<void>;
  readonly startDevServer?: (options: DevServerOptions) => Promise<string>;
  readonly resolveDevelopmentCodeFileHelperPath?: () => string | undefined;
  readonly resolveDevelopmentDataDirectory?: () => string;
  readonly generateWindowId?: () => WindowId;
  readonly generateCapability?: () => string;
  readonly generateBridgeSecret?: () => string;
  readonly bridgeSecretInput?: BridgeSecretFileInput;
  readonly stdout?: { write: (chunk: string) => unknown };
  readonly stderr?: { write: (chunk: string) => unknown };
  readonly servicePolicyStore?: HostServicePolicyReader;
}

export interface DevServerOptions {
  readonly hostname: string;
  readonly port: string;
}

export type WebCommandOutput =
  | { readonly kind: "opened"; readonly url: URL }
  | { readonly kind: "served"; readonly url: URL }
  | { readonly kind: "dev"; readonly url: URL }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "start-failed"; readonly reason: string }
  | { readonly kind: "auth-failed"; readonly reason: string };

export async function runWebCommand(options: WebCommandOptions): Promise<WebCommandOutput> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const attach = options.attachOrCreateHost ?? attachOrCreateHost;
  const createSession = options.createLaunchSession ?? createLaunchSession;
  const generateWindowId = options.generateWindowId ?? defaultGenerateWindowId;
  const generateCapability = options.generateCapability ?? defaultGenerateCapability;
  const generateBridgeSecret = options.generateBridgeSecret ?? defaultGenerateCapability;
  const developmentDataDirectory =
    options.dev === true
      ? (options.bridgeSecretInput?.env.OCTANT_DATA_DIR ??
        (options.resolveDevelopmentDataDirectory ?? resolveDevelopmentDataDirectory)())
      : undefined;
  const bridgeSecretInput =
    options.bridgeSecretInput ?? defaultBridgeSecretInput(developmentDataDirectory);

  const hostInfo = await readHostInfoFile(bridgeSecretInput);
  const fileBridgeSecret = await readBridgeSecretFile(bridgeSecretInput);
  const explicitBridgeSecret = options.bridgeSecret ?? process.env.OCTANT_DESKTOP_BRIDGE_SECRET;
  const resolvedBridgeSecret = explicitBridgeSecret ?? fileBridgeSecret ?? generateBridgeSecret();

  const hostname = options.hostname ?? (hostInfo ? hostnameFromUrl(hostInfo.url) : undefined);
  const port = options.port ?? (hostInfo ? portFromUrl(hostInfo.url) : undefined);
  const developmentCodeFileHelperPath =
    options.dev === true
      ? (options.resolveDevelopmentCodeFileHelperPath ?? resolveDevelopmentCodeFileHelperPath)()
      : undefined;
  const developmentEnvironment =
    options.dev === true
      ? {
          ...(developmentDataDirectory === undefined
            ? {}
            : { OCTANT_DATA_DIR: developmentDataDirectory }),
          ...(developmentCodeFileHelperPath === undefined
            ? {}
            : { OCTANT_CODE_FILE_HELPER_PATH: developmentCodeFileHelperPath }),
        }
      : undefined;

  const host = await attach({
    bridgeSecret: resolvedBridgeSecret,
    hostname,
    port,
    resolveAttachedHost: async () => {
      const winner = await readHostInfoFile(bridgeSecretInput);
      return winner === undefined
        ? undefined
        : { url: new URL(winner.url), instanceId: winner.instanceId };
    },
    ...(options.dev === true ? { developmentWebBootstrap: true as const } : {}),
    ...(developmentEnvironment === undefined ? {} : { environment: developmentEnvironment }),
    policyStore:
      options.servicePolicyStore ?? createDefaultServicePolicyStore(bridgeSecretInput.env),
  });
  if (host.kind === "disabled") {
    stderr.write(`${host.reason}\n`);
    return host;
  }
  if (host.kind === "start-failed") {
    stderr.write(`${host.reason}\n`);
    return host;
  }

  if (options.dev) {
    if (host.developmentWebBootstrap !== true) {
      const reason =
        "Octant development web bootstrap is unavailable on the running host. Stop or restart the host with `octant web --dev` and try again.";
      stderr.write(`${reason}\n`);
      return { kind: "auth-failed", reason };
    }
    const startDevServer = options.startDevServer ?? defaultStartDevServer;
    const devHostname = process.env.OCTANT_VITE_HOSTNAME ?? "127.0.0.1";
    const devPort = process.env.OCTANT_VITE_PORT ?? "5173";
    const devUrl = await startDevServer({ hostname: devHostname, port: devPort });
    const devUrlObject = new URL(devUrl);
    const launchUrl = buildDevLaunchUrl(devUrlObject, host.url);
    if (!options.noOpen) {
      await openBrowserSafely(options.openBrowser ?? defaultOpenBrowser, launchUrl, stdout);
    }
    stdout.write(`Octant Vite renderer listening on ${devUrlObject.toString()}\n`);
    stdout.write(`Octant host API and authority remain on ${host.url.toString()}.\n`);
    stdout.write(`Octant development history persists in ${developmentDataDirectory}.\n`);
    stdout.write(`Octant web client ready at ${launchUrl.toString()}\n`);
    return { kind: "dev", url: launchUrl };
  }

  const activeBridgeSecret =
    explicitBridgeSecret ??
    (await readStablePersistedAuthority(bridgeSecretInput, host)) ??
    resolvedBridgeSecret;

  const windowId = generateWindowId();
  const capability = generateCapability();
  let receipt;
  try {
    receipt = await createSession({
      bridgeSecret: activeBridgeSecret,
      serverUrl: host.url,
      windowId,
      capability,
    });
  } catch {
    stderr.write(
      "Octant could not reach its launch session service. The host may have exited or restarted.\n",
    );
    return {
      kind: "auth-failed",
      reason:
        "Octant could not reach its launch session service. The host may have exited or restarted.",
    };
  }
  if (receipt === undefined) {
    stderr.write(
      "Octant could not mint a launch session. The host may be unavailable or unauthorized.\n",
    );
    return {
      kind: "auth-failed",
      reason:
        "Octant could not mint a launch session. The host may be unavailable or unauthorized.",
    };
  }
  const url = buildWebClientUrl({ serverUrl: host.url, launchToken: receipt.launchToken });
  if (options.noOpen) {
    stdout.write(`Octant web client ready at ${url.toString()}\n`);
    return { kind: "served", url };
  }
  await openBrowserSafely(options.openBrowser ?? defaultOpenBrowser, url, stdout);
  stdout.write(`Octant web client opened at ${url.toString()}\n`);
  return { kind: "opened", url };
}

async function readStablePersistedAuthority(
  input: BridgeSecretFileInput,
  host: HostLauncherResult,
): Promise<string | undefined> {
  if (host.kind === "disabled" || host.kind === "start-failed" || host.instanceId === undefined) {
    return undefined;
  }
  const infoBefore = await readHostInfoFile(input);
  const secretBefore = await readBridgeSecretFile(input);
  const infoAfter = await readHostInfoFile(input);
  const secretAfter = await readBridgeSecretFile(input);
  if (
    infoBefore === undefined ||
    infoAfter === undefined ||
    secretBefore === undefined ||
    secretAfter !== secretBefore ||
    infoBefore.instanceId !== infoAfter.instanceId ||
    infoBefore.url !== infoAfter.url ||
    infoAfter.instanceId !== host.instanceId ||
    new URL(infoAfter.url).toString() !== host.url.toString()
  ) {
    return undefined;
  }
  return secretAfter;
}

function buildDevLaunchUrl(devUrl: URL, serverUrl: URL): URL {
  const url = new URL(devUrl.toString());
  url.searchParams.set("serverUrl", serverUrl.toString());
  url.searchParams.set("developmentWebBootstrap", "1");
  return url;
}

async function openBrowserSafely(
  open: (url: URL) => void | Promise<void>,
  url: URL,
  stdout: { write: (chunk: string) => unknown },
): Promise<void> {
  try {
    await open(url);
  } catch {
    stdout.write(
      `Octant could not open a browser automatically. Open this URL manually: ${url.toString()}\n`,
    );
  }
}

function hostnameFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function portFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function defaultGenerateWindowId(): WindowId {
  return crypto.randomUUID() as WindowId;
}

function defaultGenerateCapability(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

async function defaultStartDevServer(options: DevServerOptions): Promise<string> {
  const root = resolveWebRoot();
  const child = Bun.spawn({
    cmd: [
      "bun",
      "run",
      "--cwd",
      root,
      "dev",
      "--",
      "--host",
      options.hostname,
      "--port",
      options.port,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  void child.exited.catch(() => undefined);
  return `http://${options.hostname}:${options.port}`;
}

export function resolveWebRoot(): string {
  return fileURLToPath(new URL("../../../apps/web", import.meta.url));
}

export function resolveDevelopmentCodeFileHelperPath(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const path = fileURLToPath(
    new URL("../../../apps/desktop/dist/native/octant-code-file-helper", import.meta.url),
  );
  return existsSync(path) ? path : undefined;
}

export function resolveDevelopmentDataDirectory(): string {
  if (process.env.OCTANT_DATA_DIR !== undefined) return process.env.OCTANT_DATA_DIR;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Octant", "Development");
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "octant-development",
  );
}

function defaultBridgeSecretInput(developmentDataDirectory?: string): BridgeSecretFileInput {
  return {
    env:
      developmentDataDirectory === undefined
        ? process.env
        : { ...process.env, OCTANT_DATA_DIR: developmentDataDirectory },
    platform: process.platform,
    home: process.env.HOME ?? process.env.USERPROFILE ?? "",
  };
}

async function defaultOpenBrowser(url: URL): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = Bun.spawn({ cmd: [command, url.toString()], stdout: "ignore", stderr: "ignore" });
  await child.exited;
}

export type { HostLauncherResult, HostInfo };
