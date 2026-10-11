import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  attachOrCreateHost,
  buildWebClientUrl,
  createDefaultServicePolicyStore,
  createLaunchSession,
  generateWindowCapability,
  generateWindowId,
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
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
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
  | { readonly kind: "auth-failed"; readonly reason: string }
  | { readonly kind: "renderer-refused"; readonly reason: string };

export async function runWebCommand(options: WebCommandOptions): Promise<WebCommandOutput> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const attach = options.attachOrCreateHost ?? attachOrCreateHost;
  const generateBridgeSecret = options.generateBridgeSecret ?? defaultGenerateCapability;
  const developmentDataDirectory =
    options.bridgeSecretInput?.env.OCTANT_DATA_DIR ?? process.env.OCTANT_DATA_DIR;
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
  const devHostname = process.env.OCTANT_VITE_HOSTNAME ?? "127.0.0.1";
  const devPort = process.env.OCTANT_VITE_PORT ?? "5173";
  // A host started here admits the Vite renderer's exact origin; any other
  // loopback page is refused local authority.
  const developmentEnvironment =
    options.dev === true
      ? {
          OCTANT_WEB_URL: `http://${devHostname}:${devPort}`,
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
    // A host that was already running may not have been started with this
    // renderer's origin, and then refuses its local session. Ask before
    // opening a renderer that could never bootstrap.
    const devOrigin = `http://${devHostname}:${devPort}`;
    if (!(await hostAdmitsRenderer(options.fetch ?? globalThis.fetch, host.url, devOrigin))) {
      const reason =
        `The Octant host at ${host.url.toString()} does not admit the renderer origin ${devOrigin}. ` +
        `Stop that host and run this command again, or start it with OCTANT_WEB_URL=${devOrigin}.`;
      stderr.write(`${reason}\n`);
      return { kind: "renderer-refused", reason };
    }
    const startDevServer = options.startDevServer ?? defaultStartDevServer;
    const devUrl = await startDevServer({ hostname: devHostname, port: devPort });
    const devUrlObject = new URL(devUrl);
    const launchUrl = await mintLaunchUrl(host.url, devUrlObject);
    if (typeof launchUrl === "string") {
      stderr.write(`${launchUrl}\n`);
      return { kind: "auth-failed", reason: launchUrl };
    }
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
    stdout.write(
      options.noOpen
        ? `Octant web client ready at ${launchUrl.toString()}\n`
        : `Octant web client opened at ${devUrlObject.toString()}\n`,
    );
    return { kind: "dev", url: launchUrl };
  }

  const launchUrl = await mintLaunchUrl(host.url);
  if (typeof launchUrl === "string") {
    stderr.write(`${launchUrl}\n`);
    return { kind: "auth-failed", reason: launchUrl };
  }
  if (options.noOpen) {
    // The one-time link is the only way in, so it is printed here. It works
    // once, for a few minutes, and only from the page origin it names.
    stdout.write(`Octant web client ready at ${launchUrl.toString()}\n`);
    return { kind: "served", url: launchUrl };
  }
  await openBrowserSafely(options.openBrowser ?? defaultOpenBrowser, launchUrl, stdout);
  stdout.write(`Octant web client opened at ${host.url.toString()}\n`);
  return { kind: "opened", url: launchUrl };

  /**
   * A browser session starts only from a one-time launch token minted with
   * the bridge secret, which this OS user read from the owner-only runtime
   * directory. The token is bound to the renderer origin the browser opens.
   */
  async function mintLaunchUrl(serverUrl: URL, rendererUrl?: URL): Promise<URL | string> {
    // The bridge secret goes only to the host this OS user's owner-only
    // receipt names. A health probe proves nothing: while the real host is
    // stopped, another OS user can bind its port and answer `/health`, and
    // `--hostname` can name any server at all.
    const owned = await readHostInfoFile(bridgeSecretInput);
    if (
      owned === undefined ||
      new URL(owned.url).origin !== serverUrl.origin ||
      (host.kind !== "disabled" &&
        host.kind !== "start-failed" &&
        host.instanceId !== undefined &&
        owned.instanceId !== host.instanceId)
    ) {
      return `Octant did not send its bridge secret to ${serverUrl.toString()}: this OS user's host receipt does not name that host. Start the host as this user from the Octant desktop application or \`octant server\`, then run this command again.`;
    }
    // A host that won a start race owns a different secret than the one this
    // command generated; its owner projected that secret into the runtime
    // directory, so it is read again once the host is known.
    const hostBridgeSecret =
      explicitBridgeSecret ??
      (await readBridgeSecretFile(bridgeSecretInput)) ??
      resolvedBridgeSecret;
    const receipt = await createLaunchSession({
      bridgeSecret: hostBridgeSecret,
      serverUrl,
      windowId: generateWindowId(),
      capability: generateWindowCapability(),
      origin: (rendererUrl ?? serverUrl).origin,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    if (receipt === undefined) return LAUNCH_REFUSED_REASON;
    return buildWebClientUrl({
      serverUrl,
      launchToken: receipt.launchToken,
      ...(rendererUrl === undefined ? {} : { rendererUrl }),
    });
  }
}

const LAUNCH_REFUSED_REASON =
  "The Octant host refused to create a browser launch link. Run this command as the OS user that started the host, or restart the host from the Octant desktop application or `octant server`.";

async function hostAdmitsRenderer(
  fetch: (input: URL, init: RequestInit) => Promise<Response>,
  hostUrl: URL,
  origin: string,
): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/shell/local-session", hostUrl), {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
    return response.status === 204;
  } catch {
    return false;
  }
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
