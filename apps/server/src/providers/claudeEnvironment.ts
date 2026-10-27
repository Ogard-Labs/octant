import type { ClaudeAuthentication, ProviderFailure } from "@octant/contracts";
import { Effect, type Scope } from "effect";

import { snapshotClaudeHostEnvironment } from "./claudeAccountDirectory";
import {
  ISOLATED_CLAUDE_LAUNCH_GUARDS,
  ensureClaudeAccountConfigDirectory,
  hostDisableOnlySwitches,
  isolatedClaudeAccountEnvironment,
} from "./claudeAccountIsolation";

export interface ClaudeEnvironmentScope {
  readonly environment: NodeJS.ProcessEnv;
  readonly configDirectory?: string;
}

export interface ClaudeEnvironmentScopeOptions {
  readonly apiKey?: string;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  /** Claude-owned directory for this account. Isolated launches never inherit host Claude dirs. */
  readonly configDirectory?: string;
}

interface ClaudeEnvironmentOverrides {
  readonly apiKey?: string;
  readonly configDirectory?: string;
}

const PASSTHROUGH_VARIABLES = new Set([
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
]);

/**
 * Static switches every Claude launch sets; the version read keeps them too.
 * One table for both launch shapes, so the isolated and the host-directory
 * launch cannot drift apart on what they turn off.
 */
export const REQUIRED_GUARDS = ISOLATED_CLAUDE_LAUNCH_GUARDS;

/**
 * Every Claude launch names Octant as its client. The runtime sends the
 * label with each request, and the plan meters read it: the 5-hour window
 * drains roughly twice as fast per token under the Agent SDK's default
 * `sdk-*` labels as under any named client (measured across several
 * accounts and plans, 2026-09-25 through 2026-10-27; Anthropic has not
 * said whether that weighting is intended). A named client is also the
 * attribution the runtime's own hosts use, and setting it here drops a
 * label inherited from a Claude session Octant was itself launched
 * inside. The Agent SDK honours it: it writes its own `sdk-ts` only when
 * the variable is unset.
 */
const CLAUDE_LAUNCH_CLIENT_IDENTITY = { CLAUDE_CODE_ENTRYPOINT: "octant" } as const;

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function passthroughHostEnvironment(hostEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(hostEnvironment).filter(
      ([key, value]) =>
        value !== undefined && (PASSTHROUGH_VARIABLES.has(key) || key.startsWith("LC_")),
    ),
  );
}

function packagedSmokeObserverEnvironment(hostEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (hostEnvironment.OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL !== "1") return {};
  const candidate = hostEnvironment.OCTANT_CLAUDE_CONNECT_OBSERVER_URL;
  if (candidate === undefined) return {};
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return {};
    }
    return { HTTP_PROXY: candidate, HTTPS_PROXY: candidate };
  } catch {
    return {};
  }
}

export function sanitizeClaudeEnvironment(
  authentication: ClaudeAuthentication,
  hostEnvironment: NodeJS.ProcessEnv,
  overrides: ClaudeEnvironmentOverrides = {},
): NodeJS.ProcessEnv {
  if (overrides.configDirectory !== undefined) {
    const environment = isolatedClaudeAccountEnvironment({
      hostEnvironment,
      configDirectory: overrides.configDirectory,
      authentication,
      ...(overrides.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
    });
    Object.assign(
      environment,
      packagedSmokeObserverEnvironment(hostEnvironment),
      CLAUDE_LAUNCH_CLIENT_IDENTITY,
    );
    return environment;
  }

  const environment = passthroughHostEnvironment(hostEnvironment);
  Object.assign(environment, packagedSmokeObserverEnvironment(hostEnvironment));

  if (authentication === "subscription") {
    if (hostEnvironment.CLAUDE_CONFIG_DIR !== undefined) {
      environment.CLAUDE_CONFIG_DIR = hostEnvironment.CLAUDE_CONFIG_DIR;
    }
    if (hostEnvironment.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) {
      environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = hostEnvironment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    }
  } else if (overrides.apiKey !== undefined) {
    environment.ANTHROPIC_API_KEY = overrides.apiKey;
  }

  return {
    ...environment,
    ...hostDisableOnlySwitches(hostEnvironment),
    ...REQUIRED_GUARDS,
    ...CLAUDE_LAUNCH_CLIENT_IDENTITY,
  };
}

export function makeClaudeEnvironmentScope(
  authentication: ClaudeAuthentication,
  options: ClaudeEnvironmentScopeOptions = {},
): Effect.Effect<ClaudeEnvironmentScope, ProviderFailure, Scope.Scope> {
  if (options.hostEnvironment === undefined) {
    return Effect.flatMap(
      Effect.tryPromise({
        try: snapshotClaudeHostEnvironment,
        catch: () => failure("provider-failed", "Claude host environment could not be read."),
      }),
      (hostEnvironment) =>
        makeClaudeEnvironmentScope(authentication, { ...options, hostEnvironment }),
    );
  }
  const hostEnvironment = options.hostEnvironment;
  // The caller names the account directory. The driver factory resolves an
  // API-key account's assigned leaf once, so this scope never picks a folder.
  const configDirectory = options.configDirectory;

  if (configDirectory !== undefined) {
    if (authentication === "api-key") {
      if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
        return Effect.fail(
          failure(
            "invalid-configuration",
            "Claude API-key authentication requires a resolved credential.",
          ),
        );
      }
      const apiKey = options.apiKey;
      return Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await ensureClaudeAccountConfigDirectory(configDirectory);
            return {
              configDirectory,
              environment: sanitizeClaudeEnvironment(authentication, hostEnvironment, {
                apiKey,
                configDirectory,
              }),
            } satisfies ClaudeEnvironmentScope;
          },
          catch: () =>
            failure("provider-failed", "Claude account configuration could not be prepared."),
        }),
        ({ environment }) =>
          Effect.sync(() => {
            delete environment.ANTHROPIC_API_KEY;
          }),
      );
    }
    return Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await ensureClaudeAccountConfigDirectory(configDirectory);
          return {
            configDirectory,
            environment: sanitizeClaudeEnvironment(authentication, hostEnvironment, {
              configDirectory,
            }),
          } satisfies ClaudeEnvironmentScope;
        },
        catch: () =>
          failure("provider-failed", "Claude account configuration could not be prepared."),
      }),
      () => Effect.void,
    );
  }

  if (authentication === "subscription") {
    return Effect.succeed({
      environment: sanitizeClaudeEnvironment(authentication, hostEnvironment),
    });
  }

  if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
    return Effect.fail(
      failure(
        "invalid-configuration",
        "Claude API-key authentication requires a resolved credential.",
      ),
    );
  }
  return Effect.fail(
    failure(
      "invalid-configuration",
      "Claude API-key authentication requires an assigned account directory.",
    ),
  );
}
