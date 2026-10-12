import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderFailure } from "@octant/contracts";
import { Effect, Either, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { makeClaudeEnvironmentScope, sanitizeClaudeEnvironment } from "./claudeEnvironment";

const requiredGuards = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_BUG_COMMAND: "1",
} as const;

const hostileHostEnvironment: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/provider-user",
  LANG: "en_US.UTF-8",
  CLAUDE_CONFIG_DIR: "/provider/native-config",
  ANTHROPIC_API_KEY: "ambient-api-key-sentinel",
  ANTHROPIC_AUTH_TOKEN: "ambient-auth-token-sentinel",
  CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth-token-sentinel",
  OCTANT_CREDENTIAL_BROKER_TOKEN: "broker-token-sentinel",
  OCTANT_DESKTOP_BRIDGE_SECRET: "desktop-token-sentinel",
  OCTANT_CLAUDE_SMOKE_SECRET: "smoke-token-sentinel",
  CLAUDE_SMOKE_API_KEY: "smoke-api-key-sentinel",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.invalid",
  OTEL_EXPORTER_OTLP_HEADERS: "authorization=otel-sentinel",
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  ENABLE_TELEMETRY: "1",
  UNRELATED_TEST_SECRET: "unrelated-secret-sentinel",
  NODE_OPTIONS: "--require /private/injector.cjs",
  ELECTRON_RUN_AS_NODE: "1",
};

async function failureOf<A>(effect: Effect.Effect<A, ProviderFailure, never>) {
  const either = await Effect.runPromise(Effect.either(effect));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isRight(either)) throw new Error("Expected a typed provider failure.");
  return either.left;
}

describe("sanitizeClaudeEnvironment", () => {
  it("routes only an explicit packaged-smoke observer through a loopback HTTP proxy", () => {
    expect(
      sanitizeClaudeEnvironment("subscription", {
        PATH: "/usr/bin",
        OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "1",
        OCTANT_CLAUDE_CONNECT_OBSERVER_URL: "http://127.0.0.1:43123",
      }),
    ).toMatchObject({
      HTTP_PROXY: "http://127.0.0.1:43123",
      HTTPS_PROXY: "http://127.0.0.1:43123",
    });
    for (const environment of [
      {
        PATH: "/usr/bin",
        OCTANT_CLAUDE_CONNECT_OBSERVER_URL: "http://127.0.0.1:43123",
      },
      {
        PATH: "/usr/bin",
        OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "1",
        OCTANT_CLAUDE_CONNECT_OBSERVER_URL: "http://proxy.invalid:43123",
      },
    ]) {
      expect(sanitizeClaudeEnvironment("subscription", environment)).not.toHaveProperty(
        "HTTPS_PROXY",
      );
    }
  });

  it("routes the packaged-smoke observer through a loopback HTTP proxy for an isolated API-key launch", () => {
    expect(
      sanitizeClaudeEnvironment(
        "api-key",
        {
          PATH: "/usr/bin",
          HOME: "/Users/provider-user",
          OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "1",
          OCTANT_CLAUDE_CONNECT_OBSERVER_URL: "http://127.0.0.1:43123",
        },
        {
          apiKey: "broker-resolved-api-key-sentinel",
          configDirectory: "/Users/provider-user/.claude-accounts/api",
        },
      ),
    ).toMatchObject({
      HTTP_PROXY: "http://127.0.0.1:43123",
      HTTPS_PROXY: "http://127.0.0.1:43123",
      CLAUDE_CONFIG_DIR: "/Users/provider-user/.claude-accounts/api",
    });
  });

  it("allows only subscription runtime context and preserves the provider-native config location", () => {
    const environment = sanitizeClaudeEnvironment("subscription", hostileHostEnvironment);

    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/provider-user",
      LANG: "en_US.UTF-8",
      CLAUDE_CONFIG_DIR: "/provider/native-config",
      ...requiredGuards,
    });
    expect(JSON.stringify(environment)).not.toMatch(
      /ambient-|broker-token|desktop-token|smoke-|otel-sentinel|unrelated-secret|private\/injector/,
    );
  });

  it("requires the broker-resolved key for API-key mode without accepting ambient credentials", async () => {
    await expect(
      failureOf(
        Effect.scoped(
          makeClaudeEnvironmentScope("api-key", {
            hostEnvironment: hostileHostEnvironment,
          }),
        ),
      ),
    ).resolves.toEqual({
      category: "invalid-configuration",
      message: "Claude API-key authentication requires a resolved credential.",
    });
  });
});

describe("makeClaudeEnvironmentScope", () => {
  it("does not inspect or replace the provider-native subscription config location", async () => {
    const nativeConfig = "/provider/native-config-does-not-need-to-exist";
    const environment = await Effect.runPromise(
      Effect.scoped(
        makeClaudeEnvironmentScope("subscription", {
          hostEnvironment: {
            PATH: "/usr/bin",
            HOME: "/Users/provider-user",
            CLAUDE_CONFIG_DIR: nativeConfig,
          },
        }).pipe(Effect.map((scope) => scope.environment)),
      ),
    );

    expect(environment.CLAUDE_CONFIG_DIR).toBe(nativeConfig);
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("prepares an API-key launch on the account directory it is given", async () => {
    const parent = await mkdtemp(join(tmpdir(), "octant-claude-api-account-"));
    const configDirectory = join(parent, "account");
    const scope = await Effect.runPromise(Scope.make());
    try {
      const acquired = await Effect.runPromise(
        makeClaudeEnvironmentScope("api-key", {
          hostEnvironment: hostileHostEnvironment,
          apiKey: "broker-resolved-api-key-sentinel",
          configDirectory,
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      );

      expect(acquired.configDirectory).toBe(configDirectory);
      expect(statSync(configDirectory).mode & 0o777).toBe(0o700);
      expect(readdirSync(configDirectory)).toEqual([]);
      expect(acquired.environment).toEqual({
        PATH: "/usr/bin:/bin",
        HOME: "/Users/provider-user",
        LANG: "en_US.UTF-8",
        CLAUDE_CONFIG_DIR: configDirectory,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: configDirectory,
        ANTHROPIC_API_KEY: "broker-resolved-api-key-sentinel",
        ...requiredGuards,
      });
      expect(JSON.stringify(acquired.environment)).not.toMatch(
        /ambient-|broker-token|desktop-token|smoke-|otel-sentinel|unrelated-secret|private\/injector/,
      );

      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(acquired.environment.ANTHROPIC_API_KEY).toBeUndefined();
      expect(existsSync(configDirectory)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("redacts a held API environment object when its scope is released", async () => {
    const parent = await mkdtemp(join(tmpdir(), "octant-claude-api-account-"));
    const configDirectory = join(parent, "account");
    const scope = await Effect.runPromise(Scope.make());
    try {
      const acquired = await Effect.runPromise(
        makeClaudeEnvironmentScope("api-key", {
          hostEnvironment: { PATH: "/usr/bin", HOME: "/Users/provider-user" },
          apiKey: "held-api-key-sentinel",
          configDirectory,
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      const heldEnvironment = acquired.environment;

      expect(heldEnvironment.ANTHROPIC_API_KEY).toBe("held-api-key-sentinel");
      await Effect.runPromise(Scope.close(scope, Exit.void));

      expect(heldEnvironment.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses an API-key launch that names no account directory", async () => {
    const scope = await Effect.runPromise(Scope.make());
    const result = await Effect.runPromise(
      Effect.either(
        makeClaudeEnvironmentScope("api-key", {
          hostEnvironment: { PATH: "/usr/bin", HOME: "/Users/provider-user" },
          apiKey: "unused-api-key-sentinel",
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      ),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(Either.isLeft(result) ? result.left : undefined).toEqual({
      category: "invalid-configuration",
      message: "Claude API-key authentication requires an assigned account directory.",
    });
  });

  it("keeps an isolated Claude account on its directory and never sets a helper token", async () => {
    const accountDirectory = join(await mkdtemp(join(tmpdir(), "octant-claude-account-")), "work");
    const scope = await Effect.runPromise(Scope.make());
    const acquired = await Effect.runPromise(
      makeClaudeEnvironmentScope("subscription", {
        hostEnvironment: hostileHostEnvironment,
        configDirectory: accountDirectory,
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    expect(acquired.environment.CLAUDE_CONFIG_DIR).toBe(accountDirectory);
    expect(acquired.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(accountDirectory);
    expect(acquired.environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(acquired.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(existsSync(accountDirectory)).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(acquired.environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("keeps an API-key account on its stable directory instead of deleting it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "octant-claude-stable-"));
    const accountDirectory = join(parent, "account");
    const scope = await Effect.runPromise(Scope.make());
    const acquired = await Effect.runPromise(
      makeClaudeEnvironmentScope("api-key", {
        hostEnvironment: hostileHostEnvironment,
        apiKey: "broker-resolved-api-key-sentinel",
        configDirectory: accountDirectory,
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    expect(acquired.configDirectory).toBe(accountDirectory);
    expect(acquired.environment.CLAUDE_CONFIG_DIR).toBe(accountDirectory);
    expect(acquired.environment.ANTHROPIC_API_KEY).toBe("broker-resolved-api-key-sentinel");
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(acquired.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(existsSync(accountDirectory)).toBe(true);
  });

  it("never passes an ambient OAuth token to a subscription launch", async () => {
    const environment = await Effect.runPromise(
      Effect.scoped(
        makeClaudeEnvironmentScope("subscription", {
          hostEnvironment: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "ambient-token" },
        }).pipe(Effect.map((held) => held.environment)),
      ),
    );

    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
