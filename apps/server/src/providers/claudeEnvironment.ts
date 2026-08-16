import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaudeAuthentication, ProviderFailure } from "@octant/contracts";
import { Effect, type Scope } from "effect";

export interface ClaudeEnvironmentScope {
  readonly environment: NodeJS.ProcessEnv;
  readonly configDirectory?: string;
}

export interface ClaudeEnvironmentScopeOptions {
  readonly apiKey?: string;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
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

const REQUIRED_GUARDS = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_BUG_COMMAND: "1",
} as const;

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
  const environment = passthroughHostEnvironment(hostEnvironment);
  Object.assign(environment, packagedSmokeObserverEnvironment(hostEnvironment));

  if (authentication === "subscription") {
    if (hostEnvironment.CLAUDE_CONFIG_DIR !== undefined) {
      environment.CLAUDE_CONFIG_DIR = hostEnvironment.CLAUDE_CONFIG_DIR;
    }
    if (hostEnvironment.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) {
      environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = hostEnvironment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    }
  } else {
    if (overrides.configDirectory !== undefined) {
      environment.CLAUDE_CONFIG_DIR = overrides.configDirectory;
    }
    if (overrides.apiKey !== undefined) environment.ANTHROPIC_API_KEY = overrides.apiKey;
  }

  return { ...environment, ...REQUIRED_GUARDS };
}

export function makeClaudeEnvironmentScope(
  authentication: ClaudeAuthentication,
  options: ClaudeEnvironmentScopeOptions = {},
): Effect.Effect<ClaudeEnvironmentScope, ProviderFailure, Scope.Scope> {
  const hostEnvironment = options.hostEnvironment ?? process.env;

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
  const apiKey = options.apiKey;

  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const configDirectory = await mkdtemp(join(tmpdir(), "octant-claude-config-"));
        return {
          configDirectory,
          environment: sanitizeClaudeEnvironment(authentication, hostEnvironment, {
            apiKey,
            configDirectory,
          }),
        } satisfies ClaudeEnvironmentScope;
      },
      catch: () =>
        failure("provider-failed", "Claude isolated configuration could not be created."),
    }),
    ({ configDirectory, environment }) =>
      Effect.sync(() => {
        delete environment.ANTHROPIC_API_KEY;
      }).pipe(
        Effect.zipRight(
          Effect.tryPromise({
            try: () => rm(configDirectory, { recursive: true, force: true }),
            catch: () => new Error("Claude isolated configuration cleanup failed."),
          }).pipe(Effect.orDie),
        ),
      ),
  );
}
