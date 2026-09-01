import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  attachOrCreateHost,
  createDefaultServicePolicyStore,
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
  readonly openBrowser?: (url: URL) => void | Promise<void>;
  readonly startDevServer?: (options: DevServerOptions) => Promise<string>;
  readonly resolveDevelopmentCodeFileHelperPath?: () => string | undefined;
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
  const generateBridgeSecret = options.generateBridgeSecret ?? defaultGenerateCapability;
  const developmentDataDirectory = options.bridgeSecretInput?.env.OCTANT_DATA_DIR;
  const bridgeSecretInput =
    options.bridgeSecretInput ?? defaultBridgeSecretInput(developmentDataDirectory);

  const fileBridgeSecret = await readBridgeSecretFile(bridgeSecretInput);
  const explicitBridgeSecret = options.bridgeSecret ?? process.env.OCTANT_DESKTOP_BRIDGE_SECRET;
  const resolvedBridgeSecret = explicitBridgeSecret ?? fileBridgeSecret ?? generateBridgeSecret();

  const hostname = options.hostname;
  const port = options.port;
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
    ...(hostname === undefined && port === undefined
      ? {
          resolveAttachedHost: async () => {
            const winner = await readHostInfoFile(bridgeSecretInput);
            return winner === undefined
              ? undefined
              : { url: new URL(winner.url), instanceId: winner.instanceId };
          },
        }
      : {}),
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
    stdout.write(
      developmentDataDirectory === undefined
        ? "Octant development renderer uses the canonical Machine store.\n"
        : `Octant isolated development history persists in ${developmentDataDirectory}.\n`,
    );
    stdout.write(`Octant web client ready at ${launchUrl.toString()}\n`);
    return { kind: "dev", url: launchUrl };
  }

  const url = host.url;
  if (options.noOpen) {
    stdout.write(`Octant web client ready at ${url.toString()}\n`);
    return { kind: "served", url };
  }
  await openBrowserSafely(options.openBrowser ?? defaultOpenBrowser, url, stdout);
  stdout.write(`Octant web client opened at ${url.toString()}\n`);
  return { kind: "opened", url };
}

function buildDevLaunchUrl(devUrl: URL, serverUrl: URL): URL {
  const url = new URL(devUrl.toString());
  url.searchParams.set("serverUrl", serverUrl.toString());
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
