import { MAX_PROVIDER_TOOLS } from "./providers";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ProviderCapabilitySupport,
  ProviderDriverKind,
  decodeProviderDefaults,
  decodeProviderFailure,
  decodeProviderInstance,
  decodeProviderInstanceBinaryChanged,
  decodeProviderInstanceConfigurationChanged,
  decodeOllamaHistoryRecorded,
  decodeProviderModel,
  decodeProviderModelOptionValues,
  decodeProviderObservedState,
  decodeProviderProbeResult,
  decodeProviderRegistryCommand,
  decodeProviderRegistryCommandResult,
  decodeProviderRuntimeEvent,
  decodeProviderToolAnswer,
  decodeProviderTurnInput,
} from "./providers";
import * as providerContracts from "./providers";

const ids = {
  instance: "00000000-0000-4000-8000-000000000901",
  session: "00000000-0000-4000-8000-000000000902",
  correlation: "00000000-0000-4000-8000-000000000903",
} as const;

const occurredAt = "2026-07-14T10:00:00.000Z";

describe("provider registry contracts", () => {
  it("publishes the durable provider event vocabulary without entity actor provenance", () => {
    expect((providerContracts as Record<string, unknown>).PROVIDER_EVENT_NAMES).toEqual([
      "provider.instance-created@1",
      "provider.instance-renamed@1",
      "provider.instance-binary-changed@1",
      "provider.instance-configuration-changed@1",
      "provider.instance-enabled-changed@1",
      "provider.instance-removed@1",
      "provider.defaults-updated@1",
      "provider.catalog-updated@1",
    ]);
  });
  it.each([
    "codex",
    "claude",
    "opencode",
    "kilo",
    "pi",
    "oh-my-pi",
    "devin",
    "mistral-vibe",
    "ollama",
    "kimi-code",
    "grok",
    "goose",
    "glm",
    "gemini",
    "copilot",
    "cline",
    "qwen",
    "openai-compatible",
    "anthropic-compatible",
    "azure-foundry",
    "openai-image",
    "gemini-native-image",
    "bfl-image",
  ] as const)("decodes the %s driver kind", (driverKind) => {
    expect(Schema.decodeUnknownSync(ProviderDriverKind)(driverKind)).toBe(driverKind);
  });

  it("decodes an OpenCode instance without accepting provider secrets", () => {
    const instance = decodeProviderInstance({
      id: ids.instance,
      displayName: "OpenCode local",
      driverKind: "opencode",
      configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    expect(instance.driverKind).toBe("opencode");
    expect(JSON.stringify(instance)).not.toMatch(/password|token|apiKey/i);
    expect(() => decodeProviderInstance({ ...instance, serverUrl: "http://remote" })).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, token: "secret" },
      }),
    ).toThrow();
  });

  it("decodes only non-secret OpenAI-compatible configuration", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000401",
      displayName: "Private gateway",
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://gateway.example/v1/",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: ["model-a"],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    });

    expect(instance.driverKind).toBe("openai-compatible");
    expect(JSON.stringify(instance)).not.toMatch(/api.?key|credential|token/i);
    expect(() => decodeProviderInstance({ ...instance, apiKey: "secret" })).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, token: "secret" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, endpoint: "https://unsafe.example" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, manualModelIds: ["model-a", "model-a"] },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        driverKind: "opencode",
      }),
    ).toThrow();
    expect(decodeProviderInstanceConfigurationChanged({ instance })).toEqual({ instance });
    expect(() => decodeProviderInstanceBinaryChanged({ instance })).toThrow();

    const openCode = decodeProviderInstance({
      id: ids.instance,
      displayName: "OpenCode local",
      driverKind: "opencode",
      configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    expect(() => decodeProviderInstanceConfigurationChanged({ instance: openCode })).toThrow();
  });

  it("decodes only non-secret Anthropic-compatible configuration", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000411",
      displayName: "Anthropic direct",
      driverKind: "anthropic-compatible",
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://api.anthropic.example/v1/",
        authentication: "bearer",
        protocol: "auto",
        protocolVersion: "2023-06-01",
        manualModelIds: ["claude-fixture"],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
    });

    expect(instance.driverKind).toBe("anthropic-compatible");
    expect(JSON.stringify(instance)).not.toMatch(/credential|token|secret/i);
    expect(() => decodeProviderInstance({ ...instance, apiKey: "secret" })).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, token: "secret" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, headers: { "x-custom": "value" } },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, manualModelIds: ["m", "m"] },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        driverKind: "opencode",
      }),
    ).toThrow();
    expect(decodeProviderInstanceConfigurationChanged({ instance })).toEqual({ instance });
    expect(() => decodeProviderInstanceBinaryChanged({ instance })).toThrow();

    const apiKeyInstance = decodeProviderInstance({
      ...instance,
      id: "80000000-0000-4000-8000-000000000412",
      configuration: { ...instance.configuration, authentication: "api-key" },
    });
    if (apiKeyInstance.configuration.kind !== "anthropic-compatible-http") {
      throw new Error("expected anthropic-compatible configuration");
    }
    expect(apiKeyInstance.configuration.authentication).toBe("api-key");
    expect(() =>
      decodeProviderInstance({
        ...apiKeyInstance,
        configuration: { ...apiKeyInstance.configuration, authentication: "oauth" as never },
      }),
    ).toThrow();
  });

  it("decodes only non-secret Azure AI Foundry configuration", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000421",
      displayName: "Azure Foundry Work",
      driverKind: "azure-foundry",
      configuration: {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
        authentication: "api-key",
        protocol: "auto",
        manualModelIds: ["deployment-fixture"],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
    });

    expect(instance.driverKind).toBe("azure-foundry");
    expect(JSON.stringify(instance)).not.toMatch(/credential|token|secret/i);
    expect(() => decodeProviderInstance({ ...instance, apiKey: "secret" })).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, token: "secret" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, headers: { "x-custom": "value" } },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, manualModelIds: ["m", "m"] },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, authentication: "bearer" as never },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        driverKind: "opencode",
      }),
    ).toThrow();
    expect(decodeProviderInstanceConfigurationChanged({ instance })).toEqual({ instance });
    expect(() => decodeProviderInstanceBinaryChanged({ instance })).toThrow();
  });

  it("decodes an OpenAI image profile without a base URL or secret", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000431",
      displayName: "GPT Image",
      driverKind: "openai-image",
      configuration: {
        kind: "openai-image-http",
        modelAllowlist: ["gpt-image-2", "gpt-image-1"],
        defaultModel: "gpt-image-2",
        quality: "high",
        size: "1024x1024",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-08-28T10:00:00.000Z",
      updatedAt: "2026-08-28T10:00:00.000Z",
    });

    expect(instance.driverKind).toBe("openai-image");
    expect(JSON.stringify(instance)).not.toMatch(/api.?key|credential|token|baseUrl/i);
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, baseUrl: "https://api.openai.com" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, defaultModel: "gpt-image-1-mini" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: {
          ...instance.configuration,
          modelAllowlist: ["gpt-image-2", "gpt-image-2"],
        },
      }),
    ).toThrow();
    expect(decodeProviderInstanceConfigurationChanged({ instance })).toEqual({ instance });
    expect(() => decodeProviderInstanceBinaryChanged({ instance })).toThrow();
  });

  it("decodes a Gemini image profile without a base URL or secret", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000432",
      displayName: "Gemini Image",
      driverKind: "gemini-native-image",
      configuration: {
        kind: "gemini-native-image-http",
        modelAllowlist: ["gemini-3.1-flash-image", "gemini-2.5-flash-image"],
        defaultModel: "gemini-3.1-flash-image",
        aspectRatio: "16:9",
        resolution: "2K",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-08-28T10:00:00.000Z",
      updatedAt: "2026-08-28T10:00:00.000Z",
    });

    expect(instance.driverKind).toBe("gemini-native-image");
    expect(JSON.stringify(instance)).not.toMatch(/api.?key|credential|token|baseUrl/i);
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: {
          ...instance.configuration,
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, defaultModel: "gemini-3-pro-image" },
      }),
    ).toThrow();
    expect(decodeProviderInstanceConfigurationChanged({ instance })).toEqual({ instance });
  });

  it("decodes a BFL image profile without a base URL or secret", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000433",
      displayName: "FLUX",
      driverKind: "bfl-image",
      configuration: {
        kind: "bfl-image-http",
        modelAllowlist: ["flux-pro-1.1", "flux-dev"],
        defaultModel: "flux-pro-1.1",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-08-28T10:00:00.000Z",
      updatedAt: "2026-08-28T10:00:00.000Z",
    });

    expect(instance.driverKind).toBe("bfl-image");
    expect(JSON.stringify(instance)).not.toMatch(/api.?key|credential|token|baseUrl/i);
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, baseUrl: "https://api.bfl.ai" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, defaultModel: "flux-kontext-pro" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...instance,
        configuration: { ...instance.configuration, modelAllowlist: ["flux-dev", "flux-dev"] },
      }),
    ).toThrow();
    expect(decodeProviderInstanceConfigurationChanged({ instance })).toEqual({ instance });
    expect(() => decodeProviderInstanceBinaryChanged({ instance })).toThrow();
  });

  it("decodes a strict non-secret Codex instance and creation command", () => {
    const codex = {
      id: ids.instance,
      displayName: "Codex local",
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(codex)).toEqual(codex);
    expect(
      decodeProviderRegistryCommand({
        kind: "create-codex-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Codex local",
        binaryPath: "/opt/homebrew/bin/codex",
        enabled: false,
      }),
    ).toMatchObject({ kind: "create-codex-provider", enabled: false });

    expect(() =>
      decodeProviderInstance({
        ...codex,
        driverKind: "opencode",
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...codex,
        configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
      }),
    ).toThrow();

    for (const excessField of ["account", "token", "codexHome", "experimentalApi"] as const) {
      expect(() => decodeProviderInstance({ ...codex, [excessField]: "must-not-cross" })).toThrow();
    }
  });

  it("decodes only strict non-secret Claude instances, events, and commands", () => {
    const claude = {
      id: ids.instance,
      displayName: "Claude local",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(claude)).toEqual(claude);
    expect(decodeProviderInstanceConfigurationChanged({ instance: claude })).toEqual({
      instance: claude,
    });
    expect(() => decodeProviderInstanceBinaryChanged({ instance: claude })).toThrow();
    expect(
      decodeProviderRegistryCommand({
        kind: "create-claude-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Claude local",
        configuration: claude.configuration,
        enabled: false,
      }),
    ).toMatchObject({ kind: "create-claude-provider", enabled: false });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-claude-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: { ...claude.configuration, authentication: "api-key" },
      }),
    ).toMatchObject({ kind: "change-claude-configuration" });

    for (const excessField of [
      "oauthToken",
      "apiKey",
      "account",
      "configPath",
      "sessionId",
      "sdkOptions",
    ] as const) {
      expect(() =>
        decodeProviderInstance({ ...claude, [excessField]: "must-not-cross" }),
      ).toThrow();
      expect(() =>
        decodeProviderInstance({
          ...claude,
          configuration: { ...claude.configuration, [excessField]: "must-not-cross" },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeProviderInstance({
        ...claude,
        configuration: { ...claude.configuration, authentication: "oauth" },
      }),
    ).toThrow();
  });

  it("decodes only strict non-secret Mistral Vibe instances, events, and commands", () => {
    const vibe = {
      id: ids.instance,
      displayName: "Mistral Vibe local",
      driverKind: "mistral-vibe",
      configuration: {
        kind: "mistral-vibe-acp",
        binaryPath: "/Users/example/.local/bin/vibe-acp",
        authentication: "subscription",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(vibe)).toEqual(vibe);
    expect(decodeProviderInstanceConfigurationChanged({ instance: vibe })).toEqual({
      instance: vibe,
    });
    expect(() => decodeProviderInstanceBinaryChanged({ instance: vibe })).toThrow();
    expect(
      decodeProviderRegistryCommand({
        kind: "create-mistral-vibe-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: vibe.displayName,
        configuration: vibe.configuration,
      }),
    ).toMatchObject({ kind: "create-mistral-vibe-provider" });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-mistral-vibe-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: { ...vibe.configuration, authentication: "api-key" },
      }),
    ).toMatchObject({ kind: "change-mistral-vibe-configuration" });
    expect(
      decodeProviderRegistryCommand({
        kind: "begin-provider-authentication",
        instanceId: ids.instance,
      }),
    ).toMatchObject({ kind: "begin-provider-authentication" });
    expect(
      decodeProviderRegistryCommand({
        kind: "complete-provider-authentication",
        instanceId: ids.instance,
        attemptId: "provider-attempt-1",
      }),
    ).toMatchObject({ kind: "complete-provider-authentication" });
    expect(
      decodeProviderRegistryCommandResult({
        kind: "provider-authentication-started",
        instanceId: ids.instance,
        attempt: {
          attemptId: "provider-attempt-1",
          signInUrl: "https://auth.mistral.example/attempt",
          expiresAt: "2026-07-17T11:00:00.000Z",
        },
      }),
    ).toMatchObject({ kind: "provider-authentication-started" });
    expect(() =>
      decodeProviderRegistryCommandResult({
        kind: "provider-authentication-started",
        instanceId: ids.instance,
        attempt: {
          attemptId: "provider-attempt-1",
          signInUrl: "https://auth.mistral.example/attempt",
          expiresAt: "2026-07-17T11:00:00.000Z",
          oauthToken: "must-not-cross",
        },
      }),
    ).toThrow();

    for (const excessField of [
      "apiKey",
      "oauthToken",
      "account",
      "vibeHome",
      "configPath",
      "sessionId",
      "rawAcp",
    ] as const) {
      expect(() => decodeProviderInstance({ ...vibe, [excessField]: "must-not-cross" })).toThrow();
      expect(() =>
        decodeProviderInstance({
          ...vibe,
          configuration: { ...vibe.configuration, [excessField]: "must-not-cross" },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeProviderInstance({
        ...vibe,
        configuration: { ...vibe.configuration, binaryPath: "bin/vibe-acp" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...vibe,
        configuration: { ...vibe.configuration, authentication: "automatic" },
      }),
    ).toThrow();
  });

  it("decodes only strict non-secret Grok instances, events, and commands", () => {
    const grok = {
      id: ids.instance,
      displayName: "Grok Build local",
      driverKind: "grok",
      configuration: {
        kind: "grok-acp",
        binaryPath: "/Users/example/.local/bin/grok",
        authentication: "subscription",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(grok)).toEqual(grok);
    expect(decodeProviderInstanceConfigurationChanged({ instance: grok })).toEqual({
      instance: grok,
    });
    expect(() => decodeProviderInstanceBinaryChanged({ instance: grok })).toThrow();
    expect(
      decodeProviderRegistryCommand({
        kind: "create-grok-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: grok.displayName,
        configuration: grok.configuration,
      }),
    ).toMatchObject({ kind: "create-grok-provider" });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-grok-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: { ...grok.configuration, authentication: "api-key" },
      }),
    ).toMatchObject({ kind: "change-grok-configuration" });

    for (const excessField of [
      "apiKey",
      "oauthToken",
      "account",
      "grokHome",
      "sessionId",
    ] as const) {
      expect(() => decodeProviderInstance({ ...grok, [excessField]: "must-not-cross" })).toThrow();
      expect(() =>
        decodeProviderInstance({
          ...grok,
          configuration: { ...grok.configuration, [excessField]: "must-not-cross" },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeProviderInstance({
        ...grok,
        configuration: { ...grok.configuration, binaryPath: "bin/grok" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...grok,
        configuration: { ...grok.configuration, authentication: "automatic" },
      }),
    ).toThrow();
  });

  it("decodes only strict non-secret Goose instances, events, and commands", () => {
    const goose = {
      id: ids.instance,
      displayName: "Goose local",
      driverKind: "goose",
      configuration: {
        kind: "goose-acp",
        binaryPath: "/Users/example/.local/bin/goose",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(goose)).toEqual(goose);
    expect(decodeProviderInstanceConfigurationChanged({ instance: goose })).toEqual({
      instance: goose,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "create-goose-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: goose.displayName,
        configuration: goose.configuration,
      }),
    ).toMatchObject({ kind: "create-goose-provider" });
    expect(() =>
      decodeProviderInstance({
        ...goose,
        configuration: { ...goose.configuration, binaryPath: "bin/goose" },
      }),
    ).toThrow();
  });

  it("decodes only strict non-secret GLM instances, events, and commands", () => {
    const glm = {
      id: ids.instance,
      displayName: "GLM local",
      driverKind: "glm",
      configuration: {
        kind: "glm-acp",
        binaryPath: "/Users/example/.local/bin/glm-acp-agent",
        authentication: "api-key",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(glm)).toEqual(glm);
    expect(decodeProviderInstanceConfigurationChanged({ instance: glm })).toEqual({
      instance: glm,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "create-glm-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: glm.displayName,
        configuration: glm.configuration,
      }),
    ).toMatchObject({ kind: "create-glm-provider" });
    expect(() =>
      decodeProviderInstance({
        ...glm,
        configuration: { ...glm.configuration, authentication: "subscription" },
      }),
    ).toThrow();
  });

  it("decodes only strict non-secret Gemini instances, events, and commands", () => {
    const gemini = {
      id: ids.instance,
      displayName: "Gemini local",
      driverKind: "gemini",
      configuration: {
        kind: "gemini-acp",
        binaryPath: "/Users/example/.local/bin/gemini",
        authentication: "api-key",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(gemini)).toEqual(gemini);
    expect(decodeProviderInstanceConfigurationChanged({ instance: gemini })).toEqual({
      instance: gemini,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "create-gemini-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: gemini.displayName,
        configuration: gemini.configuration,
      }),
    ).toMatchObject({ kind: "create-gemini-provider" });
  });

  it("decodes only strict non-secret Copilot instances, events, and commands", () => {
    const copilot = {
      id: ids.instance,
      displayName: "Copilot local",
      driverKind: "copilot",
      configuration: {
        kind: "copilot-acp",
        binaryPath: "/Users/example/.local/bin/copilot",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(copilot)).toEqual(copilot);
    expect(decodeProviderInstanceConfigurationChanged({ instance: copilot })).toEqual({
      instance: copilot,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "create-copilot-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: copilot.displayName,
        configuration: copilot.configuration,
      }),
    ).toMatchObject({ kind: "create-copilot-provider" });
  });

  it("decodes only strict non-secret Cline instances, events, and commands", () => {
    const cline = {
      id: ids.instance,
      displayName: "Cline local",
      driverKind: "cline",
      configuration: {
        kind: "cline-acp",
        binaryPath: "/Users/example/.local/bin/cline",
        authentication: "api-key",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(cline)).toEqual(cline);
    expect(decodeProviderInstanceConfigurationChanged({ instance: cline })).toEqual({
      instance: cline,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "create-cline-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: cline.displayName,
        configuration: cline.configuration,
      }),
    ).toMatchObject({ kind: "create-cline-provider" });
  });

  it("decodes only strict non-secret Qwen instances, events, and commands", () => {
    const qwen = {
      id: ids.instance,
      displayName: "Qwen local",
      driverKind: "qwen",
      configuration: {
        kind: "qwen-acp",
        binaryPath: "/Users/example/.local/bin/qwen",
        authentication: "api-key",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(qwen)).toEqual(qwen);
    expect(decodeProviderInstanceConfigurationChanged({ instance: qwen })).toEqual({
      instance: qwen,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "create-qwen-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: qwen.displayName,
        configuration: qwen.configuration,
      }),
    ).toMatchObject({ kind: "create-qwen-provider" });
  });

  it("decodes only strict subscription-backed Devin instances, events, and commands", () => {
    const devin = {
      id: ids.instance,
      displayName: "Devin local",
      driverKind: "devin",
      configuration: {
        kind: "devin-acp",
        binaryPath: "/Users/example/.local/bin/devin",
        authentication: "subscription",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(devin)).toEqual(devin);
    expect(decodeProviderInstanceConfigurationChanged({ instance: devin })).toEqual({
      instance: devin,
    });
    expect(() => decodeProviderInstanceBinaryChanged({ instance: devin })).toThrow();
    expect(
      decodeProviderRegistryCommand({
        kind: "create-devin-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: devin.displayName,
        configuration: devin.configuration,
      }),
    ).toMatchObject({ kind: "create-devin-provider" });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-devin-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: devin.configuration,
      }),
    ).toMatchObject({ kind: "change-devin-configuration" });

    for (const excessField of [
      "apiKey",
      "oauthToken",
      "account",
      "team",
      "configPath",
      "rules",
      "processId",
      "sessionId",
      "cloudSessionId",
      "rawAcp",
    ] as const) {
      expect(() => decodeProviderInstance({ ...devin, [excessField]: "must-not-cross" })).toThrow();
      expect(() =>
        decodeProviderInstance({
          ...devin,
          configuration: { ...devin.configuration, [excessField]: "must-not-cross" },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeProviderInstance({
        ...devin,
        configuration: { ...devin.configuration, binaryPath: "bin/devin" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderInstance({
        ...devin,
        configuration: { ...devin.configuration, authentication: "api-key" },
      }),
    ).toThrow();
  });

  it("decodes only strict non-secret Kilo instances, events, and commands", () => {
    const kilo = {
      id: ids.instance,
      displayName: "Kilo local",
      driverKind: "kilo",
      configuration: {
        kind: "kilo-acp",
        binaryPath: "/opt/homebrew/bin/kilo",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(kilo)).toEqual(kilo);
    expect(decodeProviderInstanceConfigurationChanged({ instance: kilo })).toEqual({
      instance: kilo,
    });
    expect(() => decodeProviderInstanceBinaryChanged({ instance: kilo })).toThrow();
    expect(
      decodeProviderRegistryCommand({
        kind: "create-kilo-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: kilo.displayName,
        configuration: kilo.configuration,
      }),
    ).toMatchObject({ kind: "create-kilo-provider" });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-kilo-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: kilo.configuration,
      }),
    ).toMatchObject({ kind: "change-kilo-configuration" });

    for (const excessField of [
      "apiKey",
      "oauthToken",
      "account",
      "configPath",
      "kiloHome",
      "plugins",
      "skills",
      "rawAcp",
    ] as const) {
      expect(() => decodeProviderInstance({ ...kilo, [excessField]: "must-not-cross" })).toThrow();
      expect(() =>
        decodeProviderInstance({
          ...kilo,
          configuration: { ...kilo.configuration, [excessField]: "must-not-cross" },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeProviderInstance({
        ...kilo,
        configuration: { ...kilo.configuration, binaryPath: "bin/kilo" },
      }),
    ).toThrow();
  });

  it("decodes only a strict non-secret Pi RPC instance and commands", () => {
    const pi = {
      id: ids.instance,
      displayName: "Pi local",
      driverKind: "pi",
      configuration: {
        kind: "pi-rpc",
        binaryPath: "/opt/homebrew/bin/pi",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(pi)).toEqual(pi);
    expect(decodeProviderInstanceConfigurationChanged({ instance: pi })).toEqual({ instance: pi });
    expect(() => decodeProviderInstanceBinaryChanged({ instance: pi })).toThrow();
    expect(
      decodeProviderRegistryCommand({
        kind: "create-pi-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: pi.displayName,
        configuration: pi.configuration,
      }),
    ).toMatchObject({ kind: "create-pi-provider" });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-pi-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: pi.configuration,
      }),
    ).toMatchObject({ kind: "change-pi-configuration" });

    for (const excessField of [
      "apiKey",
      "oauthToken",
      "account",
      "provider",
      "model",
      "configPath",
      "sessionId",
      "rawRpc",
    ] as const) {
      expect(() => decodeProviderInstance({ ...pi, [excessField]: "must-not-cross" })).toThrow();
      expect(() =>
        decodeProviderInstance({
          ...pi,
          configuration: { ...pi.configuration, [excessField]: "must-not-cross" },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeProviderInstance({
        ...pi,
        configuration: { ...pi.configuration, binaryPath: "bin/pi" },
      }),
    ).toThrow();
  });

  it("decodes only a strict non-secret Oh My Pi RPC instance and commands", () => {
    const omp = {
      id: ids.instance,
      displayName: "Oh My Pi local",
      driverKind: "oh-my-pi",
      configuration: {
        kind: "oh-my-pi-rpc",
        binaryPath: "/Users/example/.bun/bin/omp",
        supportedVersion: "17.2.1",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(omp)).toEqual(omp);
    expect(
      decodeProviderRegistryCommand({
        kind: "create-oh-my-pi-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: omp.displayName,
        configuration: omp.configuration,
      }),
    ).toMatchObject({ kind: "create-oh-my-pi-provider" });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-oh-my-pi-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: omp.configuration,
      }),
    ).toMatchObject({ kind: "change-oh-my-pi-configuration" });
    for (const excessField of ["apiKey", "oauthToken", "rawRpc", "sessionId"] as const) {
      expect(() => decodeProviderInstance({ ...omp, [excessField]: "must-not-cross" })).toThrow();
      expect(() =>
        decodeProviderInstance({
          ...omp,
          configuration: { ...omp.configuration, [excessField]: "must-not-cross" },
        }),
      ).toThrow();
    }
  });

  it("decodes only a strict non-secret Ollama native HTTP instance and commands", () => {
    const ollama = {
      id: ids.instance,
      displayName: "Ollama local",
      driverKind: "ollama",
      configuration: {
        kind: "ollama-native-http",
        baseUrl: "http://127.0.0.1:11434",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(ollama)).toEqual(ollama);
    expect(decodeProviderInstanceConfigurationChanged({ instance: ollama })).toEqual({
      instance: ollama,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "create-ollama-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: ollama.displayName,
        configuration: ollama.configuration,
      }),
    ).toMatchObject({ kind: "create-ollama-provider" });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-ollama-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: ollama.configuration,
      }),
    ).toMatchObject({ kind: "change-ollama-configuration" });
    for (const excessField of [
      "apiKey",
      "authorization",
      "account",
      "model",
      "history",
      "prompt",
      "response",
      "rawNdjson",
    ] as const) {
      expect(() => decodeProviderInstance({ ...ollama, [excessField]: "forbidden" })).toThrow();
      expect(() =>
        decodeProviderInstance({
          ...ollama,
          configuration: { ...ollama.configuration, [excessField]: "forbidden" },
        }),
      ).toThrow();
    }
  });

  it("decodes bounded Octant-owned Ollama history snapshots for journal replay", () => {
    const recorded = {
      snapshot: {
        instanceId: ids.instance,
        sessionId: ids.session,
        root: "/tmp/octant-ollama",
        mode: "code",
        modelId: "qwen3:latest",
        history: [
          { role: "user", text: "hello" },
          { role: "assistant", text: "hi" },
        ],
      },
    } as const;
    expect(decodeOllamaHistoryRecorded(recorded)).toEqual(recorded);
    expect(() =>
      decodeOllamaHistoryRecorded({
        ...recorded,
        snapshot: { ...recorded.snapshot, history: Array(257).fill({ role: "user", text: "x" }) },
      }),
    ).toThrow();
  });

  it("decodes only a strict non-secret Kimi Code instance and creation command", () => {
    const kimi = {
      id: ids.instance,
      displayName: "Kimi Code local",
      driverKind: "kimi-code",
      configuration: {
        kind: "kimi-code-acp",
        binaryPath: "/opt/homebrew/bin/kimi",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(decodeProviderInstance(kimi)).toEqual(kimi);
    expect(decodeProviderInstanceBinaryChanged({ instance: kimi })).toEqual({ instance: kimi });
    expect(
      decodeProviderRegistryCommand({
        kind: "create-kimi-code-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Kimi Code local",
        binaryPath: "/opt/homebrew/bin/kimi",
      }),
    ).toMatchObject({ kind: "create-kimi-code-provider" });

    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-kimi-code-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Kimi Code local",
        binaryPath: "bin/kimi",
      }),
    ).toThrow();

    for (const excessField of [
      "oauthToken",
      "apiKey",
      "account",
      "configRoot",
      "processId",
      "sessionId",
      "transcript",
      "rawAcp",
    ] as const) {
      expect(() => decodeProviderInstance({ ...kimi, [excessField]: "must-not-cross" })).toThrow();
      expect(() =>
        decodeProviderInstance({
          ...kimi,
          configuration: { ...kimi.configuration, [excessField]: "must-not-cross" },
        }),
      ).toThrow();
    }
  });

  it("allows only bounded provider-specific creation commands", () => {
    expect(
      decodeProviderRegistryCommand({
        kind: "create-opencode-provider",
        instanceId: ids.instance,
        displayName: "OpenCode local",
        binaryPath: "/opt/homebrew/bin/opencode",
        expectedVersion: 0,
      }),
    ).toMatchObject({ kind: "create-opencode-provider" });
    expect(
      decodeProviderRegistryCommand({
        kind: "create-opencode-provider",
        instanceId: ids.instance,
        displayName: "OpenCode local",
        binaryPath: "/opt/homebrew/bin/opencode",
        expectedVersion: 0,
        enabled: false,
      }),
    ).toMatchObject({ kind: "create-opencode-provider", enabled: false });

    const configuration = {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1/",
      authentication: "bearer",
      protocol: "responses",
      manualModelIds: ["model-a"],
    } as const;
    expect(
      decodeProviderRegistryCommand({
        kind: "create-openai-compatible-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Private gateway",
        configuration,
      }),
    ).toMatchObject({ kind: "create-openai-compatible-provider", configuration });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-openai-compatible-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: { ...configuration, protocol: "chat-completions" },
      }),
    ).toMatchObject({ kind: "change-openai-compatible-configuration" });

    const anthropicConfiguration = {
      kind: "anthropic-compatible-http",
      baseUrl: "https://api.anthropic.example/v1/",
      authentication: "api-key",
      protocol: "auto",
      protocolVersion: "2023-06-01",
      manualModelIds: ["claude-fixture"],
    } as const;
    expect(
      decodeProviderRegistryCommand({
        kind: "create-anthropic-compatible-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Anthropic direct",
        configuration: anthropicConfiguration,
      }),
    ).toMatchObject({
      kind: "create-anthropic-compatible-provider",
      configuration: anthropicConfiguration,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-anthropic-compatible-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: { ...anthropicConfiguration, protocol: "messages" },
      }),
    ).toMatchObject({ kind: "change-anthropic-compatible-configuration" });
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-anthropic-compatible-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Anthropic direct",
        configuration: { ...anthropicConfiguration, headers: { "x-custom": "value" } },
      }),
    ).toThrow();

    const foundryConfiguration = {
      kind: "azure-foundry-openai-http",
      baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
      authentication: "api-key",
      protocol: "auto",
      manualModelIds: ["deployment-fixture"],
    } as const;
    expect(
      decodeProviderRegistryCommand({
        kind: "create-azure-foundry-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Azure Foundry Work",
        configuration: foundryConfiguration,
      }),
    ).toMatchObject({
      kind: "create-azure-foundry-provider",
      configuration: foundryConfiguration,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-azure-foundry-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: { ...foundryConfiguration, protocol: "chat-completions" },
      }),
    ).toMatchObject({ kind: "change-azure-foundry-configuration" });
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-azure-foundry-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Azure Foundry Work",
        configuration: { ...foundryConfiguration, headers: { "x-custom": "value" } },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-azure-foundry-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Azure Foundry Work",
        configuration: { ...foundryConfiguration, authentication: "bearer" as never },
      }),
    ).toThrow();

    const openAiImageConfiguration = {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2"],
      defaultModel: "gpt-image-2",
    } as const;
    expect(
      decodeProviderRegistryCommand({
        kind: "create-openai-image-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "GPT Image",
        configuration: openAiImageConfiguration,
      }),
    ).toMatchObject({
      kind: "create-openai-image-provider",
      configuration: openAiImageConfiguration,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-openai-image-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: { ...openAiImageConfiguration, quality: "high" },
      }),
    ).toMatchObject({ kind: "change-openai-image-configuration" });
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-openai-image-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "GPT Image",
        configuration: { ...openAiImageConfiguration, baseUrl: "https://api.openai.com" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-openai-image-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "GPT Image",
        configuration: { ...openAiImageConfiguration, defaultModel: "gpt-image-1" },
      }),
    ).toThrow();

    const bflImageConfiguration = {
      kind: "bfl-image-http",
      modelAllowlist: ["flux-pro-1.1"],
      defaultModel: "flux-pro-1.1",
    } as const;
    expect(
      decodeProviderRegistryCommand({
        kind: "create-bfl-image-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "FLUX",
        configuration: bflImageConfiguration,
      }),
    ).toMatchObject({
      kind: "create-bfl-image-provider",
      configuration: bflImageConfiguration,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-bfl-image-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: { ...bflImageConfiguration, defaultModel: "flux-pro-1.1" },
      }),
    ).toMatchObject({ kind: "change-bfl-image-configuration" });
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-bfl-image-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "FLUX",
        configuration: { ...bflImageConfiguration, baseUrl: "https://api.bfl.ai" },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-bfl-image-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "FLUX",
        configuration: { ...bflImageConfiguration, defaultModel: "flux-dev" },
      }),
    ).toThrow();

    const geminiImageConfiguration = {
      kind: "gemini-native-image-http",
      modelAllowlist: ["gemini-3.1-flash-image"],
      defaultModel: "gemini-3.1-flash-image",
    } as const;
    expect(
      decodeProviderRegistryCommand({
        kind: "create-gemini-native-image-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Gemini Image",
        configuration: geminiImageConfiguration,
      }),
    ).toMatchObject({
      kind: "create-gemini-native-image-provider",
      configuration: geminiImageConfiguration,
    });
    expect(
      decodeProviderRegistryCommand({
        kind: "change-gemini-native-image-configuration",
        instanceId: ids.instance,
        expectedVersion: 1,
        configuration: { ...geminiImageConfiguration, aspectRatio: "1:1" },
      }),
    ).toMatchObject({ kind: "change-gemini-native-image-configuration" });
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-gemini-native-image-provider",
        instanceId: ids.instance,
        expectedVersion: 0,
        displayName: "Gemini Image",
        configuration: {
          ...geminiImageConfiguration,
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      }),
    ).toThrow();

    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-provider",
        instanceId: ids.instance,
        driverKind: "openai-compatible",
        endpoint: "https://example.invalid",
        expectedVersion: 0,
      }),
    ).toThrow();
  });

  it("defaults registry permission persistence to the current session", () => {
    expect(
      decodeProviderDefaults({ permissionPersistence: "current-session", version: 0 }),
    ).toEqual({
      permissionPersistence: "current-session",
      version: 0,
    });
  });

  it("decodes the Settings-defined agent-eligible model defaults", () => {
    const defaults = {
      permissionPersistence: "current-session",
      agentEligibleModels: [
        { providerInstanceId: ids.instance, modelId: "gpt-5.2" },
        { providerInstanceId: ids.instance, modelId: "gpt-5.2-mini" },
      ],
      version: 3,
    } as const;
    expect(decodeProviderDefaults(defaults)).toEqual(defaults);
    expect(
      decodeProviderDefaults({ permissionPersistence: "current-session", version: 0 })
        .agentEligibleModels,
    ).toBeUndefined();
  });

  it("rejects duplicate or oversized agent-eligible model defaults", () => {
    const entry = { providerInstanceId: ids.instance, modelId: "gpt-5.2" } as const;
    expect(() =>
      decodeProviderDefaults({
        permissionPersistence: "current-session",
        agentEligibleModels: [entry, entry],
        version: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeProviderDefaults({
        permissionPersistence: "current-session",
        agentEligibleModels: Array.from({ length: 17 }, (_, index) => ({
          providerInstanceId: ids.instance,
          modelId: `model-${index}`,
        })),
        version: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeProviderDefaults({
        permissionPersistence: "current-session",
        agentEligibleModels: [{ ...entry, extra: true }],
        version: 1,
      }),
    ).toThrow();
  });

  it("accepts agent-eligible model defaults on the update-provider-defaults command", () => {
    const command = decodeProviderRegistryCommand({
      kind: "update-provider-defaults",
      expectedVersion: 2,
      permissionPersistence: "project-default",
      agentEligibleModels: [{ providerInstanceId: ids.instance, modelId: "gpt-5.2" }],
    });
    expect(command.kind).toBe("update-provider-defaults");
    if (command.kind === "update-provider-defaults") {
      expect(command.agentEligibleModels).toEqual([
        { providerInstanceId: ids.instance, modelId: "gpt-5.2" },
      ]);
    }
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "update-provider-defaults",
        expectedVersion: 2,
        permissionPersistence: "project-default",
        agentEligibleModels: [
          { providerInstanceId: ids.instance, modelId: "gpt-5.2" },
          { providerInstanceId: ids.instance, modelId: "gpt-5.2" },
        ],
      }),
    ).toThrow();
  });

  it("decodes a versioned catalog snapshot with ordering and invalidation state", () => {
    const snapshot = {
      instanceId: ids.instance,
      version: 1,
      models: [],
      manualModelOrder: ["manual-model"],
      invalidated: false,
      updatedAt: occurredAt,
    } as const;

    expect(providerContracts.decodeProviderCatalogSnapshot(snapshot)).toEqual(snapshot);
    expect(() =>
      providerContracts.decodeProviderCatalogSnapshot({
        ...snapshot,
        manualModelOrder: ["manual-model", "manual-model"],
      }),
    ).toThrow();
    const model = {
      id: "duplicate-model",
      displayName: "Duplicate model",
      source: "discovered",
      verification: "verified",
      reasoning: "unavailable",
      inputModalities: ["text"],
      options: [],
    } as const;
    expect(() =>
      providerContracts.decodeProviderCatalogSnapshot({
        ...snapshot,
        models: [model, model],
      }),
    ).toThrow();
  });

  it("allows two provider instances to expose the same model ID without collision", () => {
    const sharedModel = {
      id: "shared-model",
      displayName: "Shared model",
      source: "discovered",
      verification: "verified",
      reasoning: "supported",
      inputModalities: ["text"],
      options: [],
    } as const;
    const first = providerContracts.decodeProviderCatalogSnapshot({
      instanceId: "00000000-0000-4000-8000-000000000201",
      version: 1,
      models: [sharedModel],
      manualModelOrder: [],
      invalidated: false,
      updatedAt: occurredAt,
    });
    const second = providerContracts.decodeProviderCatalogSnapshot({
      instanceId: "00000000-0000-4000-8000-000000000202",
      version: 1,
      models: [sharedModel],
      manualModelOrder: [],
      invalidated: false,
      updatedAt: occurredAt,
    });

    expect(first.models[0]?.id).toBe("shared-model");
    expect(second.models[0]?.id).toBe("shared-model");
    expect(first.instanceId).not.toBe(second.instanceId);
    expect(
      providerContracts.decodeProviderRegistrySnapshot({
        instances: [],
        defaults: { permissionPersistence: "current-session", version: 0 },
        observedStates: [],
        catalogs: [first, second],
      }),
    ).toMatchObject({ catalogs: [first, second] });
  });

  it.each(["supported", "unsupported", "unavailable"] as const)(
    "decodes %s capability support",
    (support) => {
      expect(Schema.decodeUnknownSync(ProviderCapabilitySupport)(support)).toBe(support);
    },
  );

  it("decodes normalized models and rejects retained provider payloads", () => {
    const model = {
      id: "octant-normalized-model",
      displayName: "Normalized model",
      source: "discovered",
      verification: "verified",
      contextLimit: 128_000,
      reasoning: "supported",
      inputModalities: ["text", "image"],
      options: [
        {
          id: "reasoning-effort",
          displayName: "Reasoning effort",
          kind: "selection",
          values: ["low", "medium", "high"],
        },
      ],
    } as const;

    expect(decodeProviderModel(model)).toEqual(model);
    expect(() => decodeProviderModel({ ...model, verification: "unverified" })).toThrow();
    expect(
      decodeProviderModel({ ...model, source: "manual", verification: "unverified" }),
    ).toMatchObject({ source: "manual", verification: "unverified" });
    expect(() => decodeProviderModel({ ...model, raw: { providerID: "private" } })).toThrow();
    expect(() => decodeProviderModel({ ...model, inputModalities: ["text", "text"] })).toThrow();
    expect(() =>
      decodeProviderModel({ ...model, inputModalities: ["text", "executable"] }),
    ).toThrow();
    expect(() => decodeProviderModel({ ...model, inputModalities: [] })).toThrow();
  });

  it("keeps image input a driver-reported tri-state that defaults to absent", () => {
    const model = {
      id: "image-capable-model",
      displayName: "Image-capable model",
      source: "discovered",
      verification: "verified",
      reasoning: "unsupported",
      inputModalities: ["text"],
      options: [],
    } as const;

    // A driver that reports nothing leaves the field absent: consumers must
    // normalize absence to "unknown" and never treat it as supported.
    expect(decodeProviderModel(model).imageInput).toBeUndefined();
    expect(decodeProviderModel({ ...model, imageInput: "supported" }).imageInput).toBe("supported");
    expect(decodeProviderModel({ ...model, imageInput: "unsupported" }).imageInput).toBe(
      "unsupported",
    );
    expect(decodeProviderModel({ ...model, imageInput: "unknown" }).imageInput).toBe("unknown");
    expect(() => decodeProviderModel({ ...model, imageInput: "probably" })).toThrow();
  });

  it("decodes model capability evidence, tool metadata, limits, and ordering hints", () => {
    const model = {
      id: "evidence-backed-model",
      displayName: "Evidence-backed model",
      source: "discovered",
      verification: "verified",
      orderHint: 2,
      contextLimit: 128_000,
      maxOutputTokens: 16_384,
      reasoning: "supported",
      toolCalling: "supported",
      parallelTools: "unsupported",
      structuredOutput: "supported",
      inputModalities: ["text"],
      options: [],
      capabilityEvidence: [
        {
          capability: "tool-calling",
          support: "supported",
          source: "endpoint-observation",
          confidence: "high",
          protocol: "responses",
          observedAt: occurredAt,
          invalidated: false,
        },
      ],
    } as const;

    expect(decodeProviderModel(model)).toEqual(model);
    expect(() => decodeProviderModel({ ...model, maxOutputTokens: 0 })).toThrow();
    expect(() =>
      decodeProviderModel({
        ...model,
        capabilityEvidence: [{ ...model.capabilityEvidence[0], source: "unreviewed" }],
      }),
    ).toThrow();
  });

  it("decodes bounded provider-neutral chat turn inputs without provider payload leakage", () => {
    const turn = {
      sessionId: ids.session,
      prompt: "Compare the attached image with current sources.",
      context: [
        { kind: "instructions", text: "Stay concise." },
        { kind: "user-message", text: "What did we decide?" },
        { kind: "assistant-message", text: "We chose the local-first path." },
        { kind: "project-memory", text: "The Project prefers explicit authority." },
        { kind: "work-item", text: "Verify provider context delivery." },
      ],
      attachments: [
        {
          attachmentId: "attachment-1",
          displayName: "diagram.png",
          mediaType: "image/png",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
      tools: [
        {
          name: "octant_web_research",
          description: "Research the web with app-managed authority.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    } as const;

    expect(decodeProviderTurnInput(turn)).toEqual(turn);
    expect(JSON.stringify(turn)).not.toMatch(/codex|claude|openai|providerPayload/i);
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        attachments: [{ ...turn.attachments[0], providerPayload: { private: true } }],
      }),
    ).toThrow();
    expect(() => decodeProviderTurnInput({ ...turn, prompt: "" })).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        context: [{ kind: "provider-payload", text: "private" }],
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        context: [{ kind: "instructions", text: "" }],
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        context: Array.from({ length: 257 }, () => ({
          kind: "user-message",
          text: "bounded",
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        attachments: Array.from({ length: 17 }, (_, index) => ({
          ...turn.attachments[0],
          attachmentId: `attachment-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        tools: [{ ...turn.tools[0], description: "x".repeat(2_049) }],
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        tools: Array.from({ length: MAX_PROVIDER_TOOLS + 1 }, (_, index) => ({
          ...turn.tools[0],
          name: `tool-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        tools: [{ ...turn.tools[0], inputSchema: { ["x".repeat(129)]: true } }],
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        tools: [{ ...turn.tools[0], inputSchema: { description: "x".repeat(4_097) } }],
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        tools: [{ ...turn.tools[0], inputSchema: { values: Array(257).fill(null) } }],
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        tools: [{ ...turn.tools[0], inputSchema: { value: undefined } }],
      }),
    ).toThrow();
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        tools: [
          {
            ...turn.tools[0],
            inputSchema: Object.fromEntries(
              Array.from({ length: 20 }, (_, index) => [`field-${index}`, "x".repeat(4_096)]),
            ),
          },
        ],
      }),
    ).toThrow();
    let deeplyNestedSchema: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 17; depth += 1) {
      deeplyNestedSchema = { nested: deeplyNestedSchema };
    }
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        tools: [{ ...turn.tools[0], inputSchema: deeplyNestedSchema }],
      }),
    ).toThrow();
    const cyclicSchema: Record<string, unknown> = {};
    cyclicSchema.self = cyclicSchema;
    expect(() =>
      decodeProviderTurnInput({
        ...turn,
        tools: [{ ...turn.tools[0], inputSchema: cyclicSchema }],
      }),
    ).toThrow();
  });

  it("decodes bounded provider tool answers without provider payload leakage", () => {
    const answer = {
      sessionId: ids.session,
      requestId: "tool-request-1",
      resultJson: JSON.stringify({ sources: [] }),
      isError: false,
    } as const;

    expect(decodeProviderToolAnswer(answer)).toEqual(answer);
    expect(() =>
      decodeProviderToolAnswer({ ...answer, providerPayload: { private: true } }),
    ).toThrow();
    expect(() => decodeProviderToolAnswer({ ...answer, requestId: "" })).toThrow();
    expect(() => decodeProviderToolAnswer({ ...answer, resultJson: "not-json" })).toThrow();
  });

  it("decodes capability observations without accepting raw diagnostics", () => {
    const observed = {
      instanceId: ids.instance,
      readiness: "ready",
      processState: "running",
      detectedVersion: "1.17.19",
      observedProtocol: "responses",
      credentialStatus: "stored",
      models: [],
      capabilities: {
        streaming: "supported",
        resume: "supported",
        interruption: "supported",
        approvals: "supported",
        userQuestions: "supported",
        reasoning: "supported",
        usage: "supported",
        toolActivity: "supported",
        fileChanges: "supported",
        diffs: "supported",
        taskProgress: "supported",
        nativeChildAgents: "unavailable",
        nativeAttachments: "supported",
        nativeWebResearch: "unsupported",
        appManagedTools: "supported",
        citations: "supported",
      },
      observedAt: occurredAt,
    } as const;

    expect(decodeProviderObservedState(observed)).toEqual(observed);
    expect(decodeProviderProbeResult(observed)).toEqual(observed);
    expect(() =>
      decodeProviderObservedState({ ...observed, rawDiagnostics: { port: 1234 } }),
    ).toThrow();
  });
});

describe("provider model option values", () => {
  it("decodes bounded option-id to value records and rejects oversized ones", () => {
    expect(decodeProviderModelOptionValues({})).toEqual({});
    expect(decodeProviderModelOptionValues({ effort: "high" })).toEqual({ effort: "high" });
    expect(() => decodeProviderModelOptionValues({ effort: "" })).toThrow();
    expect(() => decodeProviderModelOptionValues({ "": "high" })).toThrow();
    expect(() =>
      decodeProviderModelOptionValues(
        Object.fromEntries(
          Array.from(
            { length: providerContracts.MAX_PROVIDER_MODEL_OPTION_VALUES + 1 },
            (_, index) => [`option-${index}`, "value"],
          ),
        ),
      ),
    ).toThrow();
  });
});

describe("provider runtime contracts", () => {
  const common = {
    instanceId: ids.instance,
    sessionId: ids.session,
    sequence: 1,
    correlationId: ids.correlation,
    occurredAt,
  } as const;

  it.each([
    { kind: "text-delta", text: "Hello" },
    { kind: "reasoning-delta", text: "Consider" },
    { kind: "tool-start", toolCallId: "tool-1", toolName: "read" },
    { kind: "tool-progress", toolCallId: "tool-1", message: "Reading" },
    { kind: "tool-success", toolCallId: "tool-1", summary: "Read file" },
    { kind: "tool-failure", toolCallId: "tool-1", message: "Denied" },
    { kind: "usage", inputTokens: 10, outputTokens: 4 },
    {
      kind: "rate-limit-bucket",
      bucket: "requests",
      limit: 1000,
      remaining: 999,
      resetsAt: "2026-07-15T10:01:00.000Z",
    },
    { kind: "file-change", path: "src/index.ts", change: "modified" },
    { kind: "diff", diff: "@@ -1 +1 @@" },
    { kind: "task-progress", taskId: "task-1", status: "in-progress", summary: "Working" },
    {
      kind: "child-agent-activity",
      childAgentId: "agent-1",
      status: "running",
      summary: "Checking",
    },
    {
      kind: "approval-request",
      requestId: "approval-1",
      action: "write-file",
      description: "Update src/index.ts",
    },
    {
      kind: "user-input-request",
      requestId: "input-1",
      prompt: "Choose a target",
      options: ["A", "B"],
    },
    { kind: "interrupted", message: "Stopped by user" },
    { kind: "waiting", message: "Provider must reconnect" },
    {
      kind: "failed",
      failure: { category: "provider-failed", message: "Provider stopped" },
    },
    {
      kind: "completed",
      resumeCursor: { driverKind: "opencode", value: "opaque-session-reference" },
    },
    {
      kind: "completed",
      resumeCursor: { driverKind: "codex", value: "opaque-thread-id" },
    },
    {
      kind: "tool-request",
      requestId: "tool-request-1",
      toolName: "octant_web_research",
      inputJson: JSON.stringify({ query: "current sources" }),
    },
    {
      kind: "citation",
      citationId: "citation-1",
      sourceTitle: "Example source",
      sourceUrl: "https://example.com/source",
      snippet: "A normalized snippet.",
    },
    {
      kind: "research-started",
      researchId: "research-1",
      query: "current sources",
      backend: "provider-native",
    },
    {
      kind: "research-completed",
      researchId: "research-1",
      sourceCount: 1,
    },
  ] as const)("decodes a strict $kind event", (event) => {
    expect(decodeProviderRuntimeEvent({ ...common, ...event })).toMatchObject(event);
    expect(() =>
      decodeProviderRuntimeEvent({ ...common, ...event, providerPayload: { private: true } }),
    ).toThrow();
  });

  it("refuses a rate-limit bucket whose remaining count exceeds its limit", () => {
    expect(() =>
      decodeProviderRuntimeEvent({
        ...common,
        kind: "rate-limit-bucket",
        bucket: "tokens",
        limit: 10,
        remaining: 11,
      }),
    ).toThrow();
  });

  it("rejects malformed normalized tool JSON and non-HTTP citation URLs", () => {
    expect(() =>
      decodeProviderRuntimeEvent({
        ...common,
        kind: "tool-request",
        requestId: "tool-request-1",
        toolName: "octant_web_research",
        inputJson: "not-json",
      }),
    ).toThrow();
    expect(() =>
      decodeProviderRuntimeEvent({
        ...common,
        kind: "citation",
        citationId: "citation-1",
        sourceTitle: "Unsafe source",
        sourceUrl: "javascript:alert(1)",
      }),
    ).toThrow();
  });

  it("keeps resume state opaque", () => {
    expect(() =>
      decodeProviderRuntimeEvent({
        ...common,
        kind: "completed",
        resumeCursor: {
          driverKind: "opencode",
          value: "opaque-session-reference",
          providerSessionId: "must-not-cross-the-boundary",
        },
      }),
    ).toThrow();
  });

  it.each([
    "unavailable",
    "unauthenticated",
    "unsupported",
    "unauthorized",
    "interrupted",
    "stale-resume",
    "invalid-configuration",
    "protocol",
    "rate-limited",
    "provider-failed",
  ] as const)("decodes the %s failure category", (category) => {
    expect(decodeProviderFailure({ category, message: "Actionable failure" })).toEqual({
      category,
      message: "Actionable failure",
    });
  });

  it("decodes bounded retry timing only", () => {
    expect(
      decodeProviderFailure({
        category: "rate-limited",
        message: "Retry later",
        retryAfterMs: 3_600_000,
      }),
    ).toEqual({ category: "rate-limited", message: "Retry later", retryAfterMs: 3_600_000 });
    expect(() =>
      decodeProviderFailure({ category: "rate-limited", message: "Retry later", retryAfterMs: 0 }),
    ).toThrow();
    expect(() =>
      decodeProviderFailure({
        category: "rate-limited",
        message: "Retry later",
        retryAfterMs: 3_600_001,
      }),
    ).toThrow();
  });
});
