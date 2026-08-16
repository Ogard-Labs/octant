import { existsSync, readdirSync, statSync } from "node:fs";

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

  it("owns an empty mode-0700 API config directory and deletes it on release", async () => {
    const scope = await Effect.runPromise(Scope.make());
    const acquired = await Effect.runPromise(
      makeClaudeEnvironmentScope("api-key", {
        hostEnvironment: hostileHostEnvironment,
        apiKey: "broker-resolved-api-key-sentinel",
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const configDirectory = acquired.configDirectory;

    expect(configDirectory).toBeDefined();
    if (configDirectory === undefined) throw new Error("Expected an isolated config directory.");
    expect(statSync(configDirectory).mode & 0o777).toBe(0o700);
    expect(readdirSync(configDirectory)).toEqual([]);
    expect(acquired.environment).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/provider-user",
      LANG: "en_US.UTF-8",
      CLAUDE_CONFIG_DIR: configDirectory,
      ANTHROPIC_API_KEY: "broker-resolved-api-key-sentinel",
      ...requiredGuards,
    });
    expect(JSON.stringify(acquired.environment)).not.toMatch(
      /ambient-|broker-token|desktop-token|smoke-|otel-sentinel|unrelated-secret|private\/injector/,
    );

    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(existsSync(configDirectory)).toBe(false);
  });

  it("redacts a held API environment object when its scope is released", async () => {
    const scope = await Effect.runPromise(Scope.make());
    const acquired = await Effect.runPromise(
      makeClaudeEnvironmentScope("api-key", {
        hostEnvironment: { PATH: "/usr/bin", HOME: "/Users/provider-user" },
        apiKey: "held-api-key-sentinel",
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const heldEnvironment = acquired.environment;

    expect(heldEnvironment.ANTHROPIC_API_KEY).toBe("held-api-key-sentinel");
    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(heldEnvironment.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
