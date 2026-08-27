import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { HostRuntimeServiceMode } from "@octant/host-runtime";

const DEFAULT_SERVER_PORT = 13_773;
const TRUSTED_PACKAGED_GH_DIRECTORIES = [
  "/usr/bin",
  "/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
] as const;

export function parseServerPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SERVER_PORT;

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OCTANT_SERVER_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function parseDesktopBridgeSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) {
    throw new Error("OCTANT_DESKTOP_BRIDGE_SECRET is invalid");
  }
  return value;
}

export function parseDevelopmentWebBootstrap(value: string | undefined): true | undefined {
  if (value === undefined) return undefined;
  if (value !== "1") {
    throw new Error("OCTANT development web bootstrap is invalid");
  }
  return true;
}

export function parseCodeFileHelperPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new Error("OCTANT_CODE_FILE_HELPER_PATH must be an absolute path");
  }
  return value;
}

/**
 * Resolve the host's `gh` command once during launch. Child processes later
 * receive this canonical absolute executable instead of consulting PATH again.
 */
export function resolveGhExecutableFromPath(
  pathValue: string | undefined,
  options: { readonly trustedOnly?: boolean } = {},
): string | undefined {
  if (pathValue === undefined) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    if (
      options.trustedOnly === true &&
      !TRUSTED_PACKAGED_GH_DIRECTORIES.includes(
        directory as (typeof TRUSTED_PACKAGED_GH_DIRECTORIES)[number],
      )
    )
      continue;
    try {
      const executable = realpathSync(join(directory, "gh"));
      if (!isAbsolute(executable) || !statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      // A host can legitimately have no supported GitHub CLI installed.
    }
  }
  return undefined;
}

export type ServerLaunchEnvironment = Readonly<Record<string, string | undefined>>;

export interface ServerLaunchConfig {
  readonly codeFileHelperPath?: string;
  readonly ghExecutable?: string;
  readonly credentialBrokerToken?: string;
  readonly credentialBrokerUrl?: string;
  readonly port: number;
  readonly instanceId?: string;
  readonly desktopBridgeSecret?: string;
  readonly developmentWebBootstrap?: true;
  readonly packagedProviderSmokeControl?: true;
  readonly hostServiceMode: Exclude<HostRuntimeServiceMode, "maintenance">;
  readonly linearOAuthClientId?: string;
  readonly linearOAuthRedirectUri?: string;
}

export function parseHostServiceMode(
  value: string | undefined,
): Exclude<HostRuntimeServiceMode, "maintenance"> {
  if (value === undefined) return "foreground";
  if (value === "desktop" || value === "foreground" || value === "web" || value === "service") {
    return value;
  }
  throw new Error("OCTANT host service mode is invalid");
}

export function parseServerInstanceId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("OCTANT server instance id is invalid");
  }
  return value;
}

export function parseServerLaunchConfig(environment: ServerLaunchEnvironment): ServerLaunchConfig {
  const packagedRuntime = environment.OCTANT_PACKAGED_RUNTIME;
  if (packagedRuntime !== undefined && packagedRuntime !== "1") {
    throw new Error("OCTANT packaged runtime is invalid");
  }
  const isPackagedRuntime = packagedRuntime === "1" || environment.ELECTRON_RUN_AS_NODE === "1";
  const instanceId = parseServerInstanceId(environment.OCTANT_SERVER_INSTANCE_ID);
  const codeFileHelperPath = parseCodeFileHelperPath(environment.OCTANT_CODE_FILE_HELPER_PATH);
  const ghExecutable = resolveGhExecutableFromPath(environment.PATH, {
    trustedOnly: isPackagedRuntime,
  });
  const desktopBridgeSecret = parseDesktopBridgeSecret(environment.OCTANT_DESKTOP_BRIDGE_SECRET);
  const developmentBootstrapValue = environment.OCTANT_DEV_WEB_BOOTSTRAP;
  if (isPackagedRuntime && developmentBootstrapValue !== undefined) {
    throw new Error("OCTANT development web bootstrap is unavailable in packaged runtime");
  }
  const developmentWebBootstrap = parseDevelopmentWebBootstrap(developmentBootstrapValue);
  const credentialBroker = parseCredentialBrokerConfig(
    environment.OCTANT_CREDENTIAL_BROKER_URL,
    environment.OCTANT_CREDENTIAL_BROKER_TOKEN,
  );
  const packagedProviderSmokeControl = environment.OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL;
  if (packagedProviderSmokeControl !== undefined && packagedProviderSmokeControl !== "1") {
    throw new Error("OCTANT packaged provider smoke control is invalid");
  }
  const linearOAuthClientId = parseLinearOAuthClientId(environment.OCTANT_LINEAR_OAUTH_CLIENT_ID);
  const linearOAuthRedirectUri = parseLinearOAuthRedirectUri(
    environment.OCTANT_LINEAR_OAUTH_REDIRECT_URI,
  );
  return {
    port: parseServerPort(environment.OCTANT_SERVER_PORT),
    hostServiceMode: parseHostServiceMode(environment.OCTANT_HOST_SERVICE_MODE),
    ...(codeFileHelperPath === undefined ? {} : { codeFileHelperPath }),
    ...(ghExecutable === undefined ? {} : { ghExecutable }),
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(desktopBridgeSecret === undefined ? {} : { desktopBridgeSecret }),
    ...(developmentWebBootstrap === undefined ? {} : { developmentWebBootstrap }),
    ...(packagedProviderSmokeControl === "1"
      ? { packagedProviderSmokeControl: true as const }
      : {}),
    ...(credentialBroker === undefined
      ? {}
      : {
          credentialBrokerUrl: credentialBroker.url,
          credentialBrokerToken: credentialBroker.token,
        }),
    ...(linearOAuthClientId === undefined ? {} : { linearOAuthClientId }),
    ...(linearOAuthRedirectUri === undefined ? {} : { linearOAuthRedirectUri }),
  };
}

export function parseLinearOAuthClientId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function parseLinearOAuthRedirectUri(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function parseCredentialBrokerConfig(
  url: string | undefined,
  token: string | undefined,
): { readonly url: string; readonly token: string } | undefined {
  if (url === undefined && token === undefined) return undefined;
  if (url === undefined || token === undefined) {
    throw new Error("OCTANT credential broker URL and token must be configured together");
  }
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) {
    throw new Error("OCTANT credential broker token is invalid");
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port === "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("OCTANT credential broker URL is invalid");
  }
  return { url, token };
}
