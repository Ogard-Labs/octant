import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type AnthropicCompatibleProviderInstance,
  type AzureFoundryProviderInstance,
  type GeminiImageProviderInstance,
  type OpenAiCompatibleProviderInstance,
  type OpenAiImageProviderInstance,
  type OpenCodeProviderInstance,
  type ProviderDefaults,
  type ProviderInstance,
} from "@octant/contracts/providers";
import { describe, expect, it } from "vitest";
import {
  ProviderPolicyRejected,
  changeAnthropicCompatibleConfiguration,
  changeAzureFoundryConfiguration,
  changeClaudeConfiguration,
  changeGeminiImageConfiguration,
  changeOpenAiCompatibleConfiguration,
  changeOpenAiImageConfiguration,
  changeProviderBinary,
  createAnthropicCompatibleProvider,
  createAzureFoundryProvider,
  createClaudeProvider,
  createGeminiImageProvider,
  createOpenAiCompatibleProvider,
  createOpenAiImageProvider,
  createCodexProvider,
  createKimiCodeProvider,
  createOpenCodeProvider,
  effectiveProviderAuthority,
  isImageProfileDriverKind,
  removeProvider,
  renameProvider,
  setProviderEnabled,
  normalizeOpenAiCompatibleBaseUrl,
  updateProviderDefaults,
} from "./providerPolicy";
import * as providerPolicy from "./providerPolicy";

const ids = {
  local: decodeProviderInstanceId("00000000-0000-4000-8000-000000000901"),
  other: decodeProviderInstanceId("00000000-0000-4000-8000-000000000902"),
} as const;
const createdAt = "2026-07-14T10:00:00.000Z" as UtcTimestamp;
const updatedAt = "2026-07-14T11:00:00.000Z" as UtcTimestamp;
const version = (value: number) => value as AggregateVersion;

function provider(overrides: Partial<OpenCodeProviderInstance> = {}): OpenCodeProviderInstance {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "OpenCode local",
    driverKind: "opencode",
    configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  if (instance.driverKind !== "opencode") throw new Error("expected OpenCode provider fixture");
  return instance;
}

function httpProvider(overrides: Record<string, unknown> = {}): OpenAiCompatibleProviderInstance {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "Private gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/api/v1/",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: ["model-a", "model-b"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  if (instance.driverKind !== "openai-compatible") {
    throw new Error("expected OpenAI-compatible provider fixture");
  }
  return instance;
}

function anthropicProvider(
  overrides: Record<string, unknown> = {},
): AnthropicCompatibleProviderInstance {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "Anthropic direct",
    driverKind: "anthropic-compatible",
    configuration: {
      kind: "anthropic-compatible-http",
      baseUrl: "https://api.anthropic.example/v1/",
      authentication: "api-key",
      protocol: "auto",
      protocolVersion: "2023-06-01",
      manualModelIds: ["claude-fixture-a", "claude-fixture-b"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  if (instance.driverKind !== "anthropic-compatible") {
    throw new Error("expected Anthropic-compatible provider fixture");
  }
  return instance;
}

function foundryProvider(overrides: Record<string, unknown> = {}): AzureFoundryProviderInstance {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "Azure Foundry Work",
    driverKind: "azure-foundry",
    configuration: {
      kind: "azure-foundry-openai-http",
      baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
      authentication: "api-key",
      protocol: "auto",
      manualModelIds: ["deployment-a", "deployment-b"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  if (instance.driverKind !== "azure-foundry") {
    throw new Error("expected Azure Foundry provider fixture");
  }
  return instance;
}

function openAiImageProvider(overrides: Record<string, unknown> = {}): OpenAiImageProviderInstance {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "GPT Image",
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2", "gpt-image-1"],
      defaultModel: "gpt-image-2",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  if (instance.driverKind !== "openai-image") {
    throw new Error("expected OpenAI image provider fixture");
  }
  return instance;
}

function geminiImageProvider(overrides: Record<string, unknown> = {}): GeminiImageProviderInstance {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "Gemini Image",
    driverKind: "gemini-native-image",
    configuration: {
      kind: "gemini-native-image-http",
      modelAllowlist: ["gemini-3.1-flash-image", "gemini-2.5-flash-image"],
      defaultModel: "gemini-3.1-flash-image",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  if (instance.driverKind !== "gemini-native-image") {
    throw new Error("expected Gemini image provider fixture");
  }
  return instance;
}

function codexProvider(): Extract<ProviderInstance, { driverKind: "codex" }> {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "Codex local",
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  if (instance.driverKind !== "codex") throw new Error("expected Codex provider fixture");
  return instance;
}

function claudeProvider(): Extract<ProviderInstance, { driverKind: "claude" }> {
  const instance = decodeProviderInstance({
    id: ids.local,
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
    createdAt,
    updatedAt: createdAt,
  });
  if (instance.driverKind !== "claude") throw new Error("expected Claude provider fixture");
  return instance;
}

function kimiCodeProvider(): Extract<ProviderInstance, { driverKind: "kimi-code" }> {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "Kimi Code local",
    driverKind: "kimi-code",
    configuration: { kind: "kimi-code-acp", binaryPath: "/opt/homebrew/bin/kimi" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  if (instance.driverKind !== "kimi-code") throw new Error("expected Kimi Code provider fixture");
  return instance;
}

function mistralVibeProvider(): Extract<ProviderInstance, { driverKind: "mistral-vibe" }> {
  const instance = decodeProviderInstance({
    id: ids.local,
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
    createdAt,
    updatedAt: createdAt,
  });
  if (instance.driverKind !== "mistral-vibe") {
    throw new Error("expected Mistral Vibe provider fixture");
  }
  return instance;
}

function grokProvider(): Extract<ProviderInstance, { driverKind: "grok" }> {
  const instance = decodeProviderInstance({
    id: ids.local,
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
    createdAt,
    updatedAt: createdAt,
  });
  if (instance.driverKind !== "grok") {
    throw new Error("expected Grok Build provider fixture");
  }
  return instance;
}

function devinProvider(): Extract<ProviderInstance, { driverKind: "devin" }> {
  const instance = decodeProviderInstance({
    id: ids.local,
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
    createdAt,
    updatedAt: createdAt,
  });
  if (instance.driverKind !== "devin") throw new Error("expected Devin provider fixture");
  return instance;
}

function piProvider(): Extract<ProviderInstance, { driverKind: "pi" }> {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "Pi local",
    driverKind: "pi",
    configuration: { kind: "pi-rpc", binaryPath: "/opt/homebrew/bin/pi" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  if (instance.driverKind !== "pi") throw new Error("expected Pi provider fixture");
  return instance;
}

function ollamaProvider(): Extract<ProviderInstance, { driverKind: "ollama" }> {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "Ollama local",
    driverKind: "ollama",
    configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  if (instance.driverKind !== "ollama") throw new Error("expected Ollama provider fixture");
  return instance;
}

describe("provider instance policy", () => {
  it.each([
    ["https://host.example/api/v1", "https://host.example/api/v1/"],
    ["https://host.example/api/%3F/%23", "https://host.example/api/%3F/%23/"],
    ["http://127.0.0.1:11434/v1/", "http://127.0.0.1:11434/v1/"],
  ])("normalizes allowed provider bases", (input, expected) => {
    expect(normalizeOpenAiCompatibleBaseUrl(input)).toBe(expected);
  });

  it.each([
    "http://host.example/v1",
    "http://127.evil.example/v1",
    "https://u:p@host/v1",
    "https://host/v1?q=1",
    "https://host/v1?",
    "https://host/v1#x",
    "https://host/v1#",
  ])("rejects unsafe provider base %s", (input) => {
    expect(() => normalizeOpenAiCompatibleBaseUrl(input)).toThrow();
  });

  it("creates a complete HTTP provider with normalized models and loopback no-auth", () => {
    expect(
      createOpenAiCompatibleProvider({
        id: ids.local,
        displayName: "  Local gateway  ",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: " http://localhost:11434/api/v1 ",
          authentication: "none",
          protocol: "responses",
          manualModelIds: [" model-a ", "model-a", " model-b "],
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(
      httpProvider({
        displayName: "Local gateway",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "http://localhost:11434/api/v1/",
          authentication: "none",
          protocol: "responses",
          manualModelIds: ["model-a", "model-b"],
        },
      }),
    );
  });

  it("requires Bearer authentication for remote HTTPS providers", () => {
    expect(() =>
      createOpenAiCompatibleProvider({
        id: ids.local,
        displayName: "Private gateway",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://gateway.example/v1",
          authentication: "none",
          protocol: "auto",
          manualModelIds: [],
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Unauthenticated providers must use a loopback endpoint.");
  });

  it("returns a complete immutable HTTP configuration update", () => {
    const original = httpProvider();
    const changed = changeOpenAiCompatibleConfiguration(
      original,
      {
        kind: "openai-compatible-http",
        baseUrl: "https://gateway.example/v2",
        authentication: "bearer",
        protocol: "chat-completions",
        manualModelIds: [" model-c ", "model-c"],
      },
      updatedAt,
    );

    expect(changed).toEqual({
      ...original,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://gateway.example/v2/",
        authentication: "bearer",
        protocol: "chat-completions",
        manualModelIds: ["model-c"],
      },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(httpProvider());
  });

  it("creates a complete Anthropic-compatible provider with normalized models and protocol version", () => {
    expect(
      createAnthropicCompatibleProvider({
        id: ids.local,
        displayName: "  Anthropic direct  ",
        configuration: {
          kind: "anthropic-compatible-http",
          baseUrl: " https://api.anthropic.example/v1 ",
          authentication: "api-key",
          protocol: "auto",
          protocolVersion: " 2023-06-01 ",
          manualModelIds: [" claude-fixture-a ", "claude-fixture-a", " claude-fixture-b "],
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(
      anthropicProvider({
        displayName: "Anthropic direct",
        configuration: {
          kind: "anthropic-compatible-http",
          baseUrl: "https://api.anthropic.example/v1/",
          authentication: "api-key",
          protocol: "auto",
          protocolVersion: "2023-06-01",
          manualModelIds: ["claude-fixture-a", "claude-fixture-b"],
        },
      }),
    );
  });

  it("requires authentication for remote Anthropic-compatible endpoints", () => {
    expect(() =>
      createAnthropicCompatibleProvider({
        id: ids.local,
        displayName: "Anthropic direct",
        configuration: {
          kind: "anthropic-compatible-http",
          baseUrl: "https://api.anthropic.example/v1",
          authentication: "none",
          protocol: "auto",
          protocolVersion: "2023-06-01",
          manualModelIds: [],
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Unauthenticated providers must use a loopback endpoint.");
  });

  it("allows loopback Anthropic-compatible endpoints without authentication", () => {
    const instance = createAnthropicCompatibleProvider({
      id: ids.local,
      displayName: "Local Anthropic",
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "http://127.0.0.1:8080/v1",
        authentication: "none",
        protocol: "messages",
        protocolVersion: "2023-06-01",
        manualModelIds: ["local-claude"],
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(instance.configuration.baseUrl).toBe("http://127.0.0.1:8080/v1/");
    expect(instance.configuration.authentication).toBe("none");
  });

  it("returns a complete immutable Anthropic-compatible configuration update", () => {
    const original = anthropicProvider();
    const changed = changeAnthropicCompatibleConfiguration(
      original,
      {
        kind: "anthropic-compatible-http",
        baseUrl: "https://api.anthropic.example/v2",
        authentication: "bearer",
        protocol: "messages",
        protocolVersion: "2024-01-01",
        manualModelIds: [" claude-fixture-c ", "claude-fixture-c"],
      },
      updatedAt,
    );

    expect(changed).toEqual({
      ...original,
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://api.anthropic.example/v2/",
        authentication: "bearer",
        protocol: "messages",
        protocolVersion: "2024-01-01",
        manualModelIds: ["claude-fixture-c"],
      },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(anthropicProvider());
  });

  it("creates a complete Azure AI Foundry provider with normalized deployments and api-key auth", () => {
    expect(
      createAzureFoundryProvider({
        id: ids.local,
        displayName: "  Azure Foundry Work  ",
        configuration: {
          kind: "azure-foundry-openai-http",
          baseUrl: " https://foundry.example.openai.azure.com/openai/v1 ",
          authentication: "api-key",
          protocol: "auto",
          manualModelIds: [" deployment-a ", "deployment-a", " deployment-b "],
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(
      foundryProvider({
        displayName: "Azure Foundry Work",
        configuration: {
          kind: "azure-foundry-openai-http",
          baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
          authentication: "api-key",
          protocol: "auto",
          manualModelIds: ["deployment-a", "deployment-b"],
        },
      }),
    );
  });

  it("rejects Azure AI Foundry base URLs that do not end with /openai/v1/", () => {
    expect(() =>
      createAzureFoundryProvider({
        id: ids.local,
        displayName: "Azure Foundry Work",
        configuration: {
          kind: "azure-foundry-openai-http",
          baseUrl: "https://foundry.example.openai.azure.com/v1",
          authentication: "api-key",
          protocol: "auto",
          manualModelIds: ["deployment-a"],
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Azure AI Foundry base URL must end with the /openai/v1/ path.");
  });

  it("rejects non-API-key Azure AI Foundry authentication in the technical preview", () => {
    expect(() =>
      createAzureFoundryProvider({
        id: ids.local,
        displayName: "Azure Foundry Work",
        configuration: {
          kind: "azure-foundry-openai-http",
          baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
          authentication: "bearer" as never,
          protocol: "auto",
          manualModelIds: ["deployment-a"],
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Azure AI Foundry technical preview supports API-key authentication only.");
  });

  it("rejects an Azure AI Foundry configuration with no deployment IDs", () => {
    expect(() =>
      createAzureFoundryProvider({
        id: ids.local,
        displayName: "Azure Foundry Work",
        configuration: {
          kind: "azure-foundry-openai-http",
          baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
          authentication: "api-key",
          protocol: "auto",
          manualModelIds: [],
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Azure AI Foundry requires at least one deployment ID.");
  });

  it("returns a complete immutable Azure AI Foundry configuration update", () => {
    const original = foundryProvider();
    const changed = changeAzureFoundryConfiguration(
      original,
      {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://foundry.example.openai.azure.com/openai/v1",
        authentication: "api-key",
        protocol: "chat-completions",
        manualModelIds: [" deployment-c ", "deployment-c"],
      },
      updatedAt,
    );

    expect(changed).toEqual({
      ...original,
      configuration: {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
        authentication: "api-key",
        protocol: "chat-completions",
        manualModelIds: ["deployment-c"],
      },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(foundryProvider());
  });

  it("creates an OpenAI image profile with a normalized allowlist and default model", () => {
    expect(
      createOpenAiImageProvider({
        id: ids.local,
        displayName: "  GPT Image  ",
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: [" gpt-image-2 ", "gpt-image-2", " gpt-image-1 "],
          defaultModel: " gpt-image-2 ",
          quality: "high",
          size: "1024x1024",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(
      openAiImageProvider({
        displayName: "GPT Image",
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: ["gpt-image-2", "gpt-image-1"],
          defaultModel: "gpt-image-2",
          quality: "high",
          size: "1024x1024",
        },
      }),
    );
  });

  it("rejects an OpenAI image profile whose default model is not in the allowlist", () => {
    expect(() =>
      createOpenAiImageProvider({
        id: ids.local,
        displayName: "GPT Image",
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: ["gpt-image-2"],
          defaultModel: "gpt-image-1",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Default model must be a member of the model allowlist.");
  });

  it("rejects an OpenAI image profile with no model IDs", () => {
    expect(() =>
      createOpenAiImageProvider({
        id: ids.local,
        displayName: "GPT Image",
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: [],
          defaultModel: "gpt-image-2",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Image profiles require at least one model ID.");
  });

  it("returns a complete immutable OpenAI image configuration update", () => {
    const original = openAiImageProvider();
    const changed = changeOpenAiImageConfiguration(
      original,
      {
        kind: "openai-image-http",
        modelAllowlist: [" gpt-image-1 ", "gpt-image-1"],
        defaultModel: " gpt-image-1 ",
        quality: "low",
      },
      updatedAt,
    );

    expect(changed).toEqual({
      ...original,
      configuration: {
        kind: "openai-image-http",
        modelAllowlist: ["gpt-image-1"],
        defaultModel: "gpt-image-1",
        quality: "low",
      },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(openAiImageProvider());
  });

  it("creates a Gemini image profile with a normalized allowlist and default model", () => {
    expect(
      createGeminiImageProvider({
        id: ids.local,
        displayName: "  Gemini Image  ",
        configuration: {
          kind: "gemini-native-image-http",
          modelAllowlist: [
            " gemini-3.1-flash-image ",
            "gemini-3.1-flash-image",
            " gemini-2.5-flash-image ",
          ],
          defaultModel: " gemini-3.1-flash-image ",
          aspectRatio: "16:9",
          resolution: "2K",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(
      geminiImageProvider({
        displayName: "Gemini Image",
        configuration: {
          kind: "gemini-native-image-http",
          modelAllowlist: ["gemini-3.1-flash-image", "gemini-2.5-flash-image"],
          defaultModel: "gemini-3.1-flash-image",
          aspectRatio: "16:9",
          resolution: "2K",
        },
      }),
    );
  });

  it("rejects a Gemini image profile whose default model is not in the allowlist", () => {
    expect(() =>
      createGeminiImageProvider({
        id: ids.local,
        displayName: "Gemini Image",
        configuration: {
          kind: "gemini-native-image-http",
          modelAllowlist: ["gemini-3.1-flash-image"],
          defaultModel: "gemini-3-pro-image",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Default model must be a member of the model allowlist.");
  });

  it("returns a complete immutable Gemini image configuration update", () => {
    const original = geminiImageProvider();
    const changed = changeGeminiImageConfiguration(
      original,
      {
        kind: "gemini-native-image-http",
        modelAllowlist: [" gemini-3-pro-image ", "gemini-3-pro-image"],
        defaultModel: " gemini-3-pro-image ",
        resolution: "4K",
      },
      updatedAt,
    );

    expect(changed).toEqual({
      ...original,
      configuration: {
        kind: "gemini-native-image-http",
        modelAllowlist: ["gemini-3-pro-image"],
        defaultModel: "gemini-3-pro-image",
        resolution: "4K",
      },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(geminiImageProvider());
  });

  it("classifies image profiles separately from chat drivers", () => {
    expect(isImageProfileDriverKind("openai-image")).toBe(true);
    expect(isImageProfileDriverKind("gemini-native-image")).toBe(true);
    expect(isImageProfileDriverKind("openai-compatible")).toBe(false);
  });

  it("removes an image profile when it has no active sessions", () => {
    const original = openAiImageProvider();
    expect(removeProvider(original, { activeSessionCount: 0, updatedAt })).toEqual({
      ...original,
      version: 2,
      updatedAt,
    });
    expect(() => removeProvider(original, { activeSessionCount: 1 })).toThrow(
      "Stop active sessions before removing this provider.",
    );
  });

  it("creates a complete OpenCode instance with normalized input", () => {
    expect(
      createOpenCodeProvider({
        id: ids.local,
        displayName: "  OpenCode local  ",
        binaryPath: "  /opt/homebrew/bin/opencode  ",
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(provider());
  });

  it("creates a complete Codex instance and preserves its configuration kind on update", () => {
    const original = codexProvider();

    expect(
      createCodexProvider({
        id: ids.local,
        displayName: "  Codex local ",
        binaryPath: " /opt/homebrew/bin/codex ",
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(original);
    expect(
      changeProviderBinary(original, {
        binaryPath: "/usr/local/bin/codex",
        updatedAt,
      }),
    ).toMatchObject({
      configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
    });
  });

  it("creates a disabled Codex instance when enabled is false", () => {
    const instance = createCodexProvider({
      id: ids.local,
      displayName: "Codex local",
      binaryPath: "/opt/homebrew/bin/codex",
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
      enabled: false,
    });

    expect(instance.enabled).toBe(false);
    expect(instance).toEqual({ ...codexProvider(), enabled: false });
  });

  it("defaults Connect-style creates to enabled when enabled is omitted", () => {
    expect(
      createOpenCodeProvider({
        id: ids.local,
        displayName: "OpenCode local",
        binaryPath: "/opt/homebrew/bin/opencode",
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }).enabled,
    ).toBe(true);
    expect(
      createCodexProvider({
        id: ids.local,
        displayName: "Codex local",
        binaryPath: "/opt/homebrew/bin/codex",
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }).enabled,
    ).toBe(true);
    expect(
      createKimiCodeProvider({
        id: ids.local,
        displayName: "Kimi Code local",
        binaryPath: "/opt/homebrew/bin/kimi",
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }).enabled,
    ).toBe(true);
  });

  it("creates and immutably updates a Kimi Code instance with an absolute binary path", () => {
    const original = createKimiCodeProvider({
      id: ids.local,
      displayName: "  Kimi Code local ",
      binaryPath: " /opt/homebrew/bin/kimi ",
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });

    expect(original).toEqual(kimiCodeProvider());
    expect(
      changeProviderBinary(original, {
        binaryPath: " /usr/local/bin/kimi ",
        activeSessionCount: 0,
        updatedAt,
      }),
    ).toEqual({
      ...original,
      configuration: { kind: "kimi-code-acp", binaryPath: "/usr/local/bin/kimi" },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(kimiCodeProvider());

    expect(() =>
      createKimiCodeProvider({
        id: ids.local,
        displayName: "Kimi Code local",
        binaryPath: "bin/kimi",
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider binary path must be absolute.");
  });

  it("rejects a Kimi Code binary change while sessions are active", () => {
    const original = kimiCodeProvider();
    expect(() =>
      changeProviderBinary(original, {
        binaryPath: "/usr/local/bin/kimi",
        activeSessionCount: 1,
        updatedAt,
      }),
    ).toThrow("Stop active sessions before changing this provider runtime.");
    expect(original).toEqual(kimiCodeProvider());
  });

  it("creates a Claude instance with a normalized binary path and explicit authentication", () => {
    expect(
      createClaudeProvider({
        id: ids.local,
        displayName: "  Claude local  ",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "  /opt/homebrew/bin/claude  ",
          authentication: "subscription",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(claudeProvider());

    expect(() =>
      createClaudeProvider({
        id: ids.local,
        displayName: "Claude local",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "oauth" as never,
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Claude authentication must be subscription or api-key.");
  });

  it("creates and immutably updates Mistral Vibe with explicit selected authentication", () => {
    const policy = providerPolicy as unknown as {
      createMistralVibeProvider: (input: Record<string, unknown>) => ProviderInstance;
      changeMistralVibeConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "mistral-vibe" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    const original = policy.createMistralVibeProvider({
      id: ids.local,
      displayName: "  Mistral Vibe local  ",
      configuration: {
        kind: "mistral-vibe-acp",
        binaryPath: " /Users/example/.local/bin/vibe-acp ",
        authentication: "subscription",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });

    expect(original).toEqual(mistralVibeProvider());
    expect(
      policy.changeMistralVibeConfiguration(
        mistralVibeProvider(),
        {
          kind: "mistral-vibe-acp",
          binaryPath: "/opt/homebrew/bin/vibe-acp",
          authentication: "api-key",
        },
        updatedAt,
        0,
      ),
    ).toEqual({
      ...mistralVibeProvider(),
      configuration: {
        kind: "mistral-vibe-acp",
        binaryPath: "/opt/homebrew/bin/vibe-acp",
        authentication: "api-key",
      },
      version: 2,
      updatedAt,
    });
    expect(mistralVibeProvider().configuration.authentication).toBe("subscription");
  });

  it("rejects invalid Mistral Vibe authentication, relative binaries, and active updates", () => {
    const policy = providerPolicy as unknown as {
      createMistralVibeProvider: (input: Record<string, unknown>) => ProviderInstance;
      changeMistralVibeConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "mistral-vibe" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    expect(() =>
      policy.createMistralVibeProvider({
        id: ids.local,
        displayName: "Mistral Vibe local",
        configuration: {
          kind: "mistral-vibe-acp",
          binaryPath: "bin/vibe-acp",
          authentication: "subscription",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider binary path must be absolute.");
    expect(() =>
      policy.createMistralVibeProvider({
        id: ids.local,
        displayName: "Mistral Vibe local",
        configuration: {
          kind: "mistral-vibe-acp",
          binaryPath: "/Users/example/.local/bin/vibe-acp",
          authentication: "automatic",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Mistral Vibe authentication must be subscription or api-key.");
    expect(() =>
      policy.changeMistralVibeConfiguration(
        mistralVibeProvider(),
        mistralVibeProvider().configuration,
        updatedAt,
        1,
      ),
    ).toThrow("Stop active sessions before changing this provider runtime.");
  });

  it("creates and immutably updates Grok Build with explicit selected authentication", () => {
    const policy = providerPolicy as unknown as {
      createGrokProvider: (input: Record<string, unknown>) => ProviderInstance;
      changeGrokConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "grok" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    const original = policy.createGrokProvider({
      id: ids.local,
      displayName: "  Grok Build local  ",
      configuration: {
        kind: "grok-acp",
        binaryPath: " /Users/example/.local/bin/grok ",
        authentication: "subscription",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });

    expect(original).toEqual(grokProvider());
    expect(
      policy.changeGrokConfiguration(
        grokProvider(),
        {
          kind: "grok-acp",
          binaryPath: "/opt/homebrew/bin/grok",
          authentication: "api-key",
        },
        updatedAt,
        0,
      ),
    ).toEqual({
      ...grokProvider(),
      configuration: {
        kind: "grok-acp",
        binaryPath: "/opt/homebrew/bin/grok",
        authentication: "api-key",
      },
      version: 2,
      updatedAt,
    });
    expect(grokProvider().configuration.authentication).toBe("subscription");
  });

  it("rejects invalid Grok Build authentication, relative binaries, and active updates", () => {
    const policy = providerPolicy as unknown as {
      createGrokProvider: (input: Record<string, unknown>) => ProviderInstance;
      changeGrokConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "grok" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    expect(() =>
      policy.createGrokProvider({
        id: ids.local,
        displayName: "Grok Build local",
        configuration: {
          kind: "grok-acp",
          binaryPath: "bin/grok",
          authentication: "subscription",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider binary path must be absolute.");
    expect(() =>
      policy.createGrokProvider({
        id: ids.local,
        displayName: "Grok Build local",
        configuration: {
          kind: "grok-acp",
          binaryPath: "/Users/example/.local/bin/grok",
          authentication: "automatic",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Grok Build authentication must be subscription or api-key.");
    expect(() =>
      policy.changeGrokConfiguration(grokProvider(), grokProvider().configuration, updatedAt, 1),
    ).toThrow("Stop active sessions before changing this provider runtime.");
  });

  it("creates and immutably updates Goose with provider-owned configuration", () => {
    const policy = providerPolicy as unknown as {
      createGooseProvider: (input: Record<string, unknown>) => ProviderInstance;
      changeGooseConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "goose" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    const original = policy.createGooseProvider({
      id: ids.local,
      displayName: "  Goose local  ",
      configuration: {
        kind: "goose-acp",
        binaryPath: " /Users/example/.local/bin/goose ",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(original).toEqual({
      id: ids.local,
      displayName: "Goose local",
      driverKind: "goose",
      configuration: {
        kind: "goose-acp",
        binaryPath: "/Users/example/.local/bin/goose",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
  });

  it("creates and immutably updates GLM Agent with api-key authentication", () => {
    const policy = providerPolicy as unknown as {
      createGlmProvider: (input: Record<string, unknown>) => ProviderInstance;
      changeGlmConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "glm" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    const original = policy.createGlmProvider({
      id: ids.local,
      displayName: "  GLM local  ",
      configuration: {
        kind: "glm-acp",
        binaryPath: " /Users/example/.local/bin/glm-acp-agent ",
        authentication: "api-key",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(original.configuration).toEqual({
      kind: "glm-acp",
      binaryPath: "/Users/example/.local/bin/glm-acp-agent",
      authentication: "api-key",
    });
    expect(() =>
      policy.createGlmProvider({
        id: ids.local,
        displayName: "GLM local",
        configuration: {
          kind: "glm-acp",
          binaryPath: "/Users/example/.local/bin/glm-acp-agent",
          authentication: "subscription",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("GLM Agent authentication must be api-key.");
  });

  it("creates and immutably updates Devin with subscription authentication", () => {
    const policy = providerPolicy as unknown as {
      createDevinProvider: (input: Record<string, unknown>) => ProviderInstance;
      changeDevinConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "devin" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    const original = policy.createDevinProvider({
      id: ids.local,
      displayName: "  Devin local  ",
      configuration: {
        kind: "devin-acp",
        binaryPath: " /Users/example/.local/bin/devin ",
        authentication: "subscription",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });

    expect(original).toEqual(devinProvider());
    expect(
      policy.changeDevinConfiguration(
        devinProvider(),
        {
          kind: "devin-acp",
          binaryPath: "/opt/homebrew/bin/devin",
          authentication: "subscription",
        },
        updatedAt,
        0,
      ),
    ).toEqual({
      ...devinProvider(),
      configuration: {
        kind: "devin-acp",
        binaryPath: "/opt/homebrew/bin/devin",
        authentication: "subscription",
      },
      version: 2,
      updatedAt,
    });
    expect(devinProvider().configuration.binaryPath).toBe("/Users/example/.local/bin/devin");
  });

  it("rejects invalid Devin authentication, relative binaries, and active updates", () => {
    const policy = providerPolicy as unknown as {
      createDevinProvider: (input: Record<string, unknown>) => ProviderInstance;
      changeDevinConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "devin" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    expect(() =>
      policy.createDevinProvider({
        id: ids.local,
        displayName: "Devin local",
        configuration: {
          kind: "devin-acp",
          binaryPath: "bin/devin",
          authentication: "subscription",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider binary path must be absolute.");
    expect(() =>
      policy.createDevinProvider({
        id: ids.local,
        displayName: "Devin local",
        configuration: {
          kind: "devin-acp",
          binaryPath: "/Users/example/.local/bin/devin",
          authentication: "api-key",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Devin authentication must be subscription.");
    expect(() =>
      policy.changeDevinConfiguration(devinProvider(), devinProvider().configuration, updatedAt, 1),
    ).toThrow("Stop active sessions before changing this provider runtime.");
  });

  it("creates and immutably updates Pi while rejecting relative binaries and active updates", () => {
    const policy = providerPolicy as unknown as {
      createPiProvider: (input: Record<string, unknown>) => ProviderInstance;
      changePiConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "pi" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    const original = policy.createPiProvider({
      id: ids.local,
      displayName: "  Pi local  ",
      configuration: { kind: "pi-rpc", binaryPath: " /opt/homebrew/bin/pi " },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });

    expect(original).toEqual(piProvider());
    expect(
      policy.changePiConfiguration(
        piProvider(),
        { kind: "pi-rpc", binaryPath: "/usr/local/bin/pi" },
        updatedAt,
        0,
      ),
    ).toEqual({
      ...piProvider(),
      configuration: { kind: "pi-rpc", binaryPath: "/usr/local/bin/pi" },
      version: 2,
      updatedAt,
    });
    expect(() =>
      policy.createPiProvider({
        id: ids.local,
        displayName: "Pi local",
        configuration: { kind: "pi-rpc", binaryPath: "bin/pi" },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider binary path must be absolute.");
    expect(() =>
      policy.changePiConfiguration(piProvider(), piProvider().configuration, updatedAt, 1),
    ).toThrow("Stop active sessions before changing this provider runtime.");
  });

  it("creates and immutably updates Kilo while rejecting relative binaries and active updates", () => {
    const policy = providerPolicy as unknown as {
      createKiloProvider: (
        input: Record<string, unknown>,
      ) => Extract<ProviderInstance, { driverKind: "kilo" }>;
      changeKiloConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "kilo" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => Extract<ProviderInstance, { driverKind: "kilo" }>;
    };
    const original = policy.createKiloProvider({
      id: ids.local,
      displayName: "  Kilo local  ",
      configuration: { kind: "kilo-acp", binaryPath: " /opt/homebrew/bin/kilo " },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(original).toMatchObject({
      displayName: "Kilo local",
      driverKind: "kilo",
      configuration: { kind: "kilo-acp", binaryPath: "/opt/homebrew/bin/kilo" },
      version: 1,
    });
    const updated = policy.changeKiloConfiguration(
      original,
      { kind: "kilo-acp", binaryPath: "/usr/local/bin/kilo" },
      updatedAt,
    );
    expect(updated).toMatchObject({
      configuration: { kind: "kilo-acp", binaryPath: "/usr/local/bin/kilo" },
      version: 2,
      updatedAt,
    });
    expect(original.configuration.binaryPath).toBe("/opt/homebrew/bin/kilo");
    expect(() =>
      policy.createKiloProvider({
        id: ids.local,
        displayName: "Kilo local",
        configuration: { kind: "kilo-acp", binaryPath: "bin/kilo" },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider binary path must be absolute.");
    expect(() =>
      policy.changeKiloConfiguration(original, original.configuration, updatedAt, 1),
    ).toThrow("Stop active sessions before changing this provider runtime.");
  });

  it("creates and updates Ollama while accepting only exact loopback HTTP origins", () => {
    const policy = providerPolicy as unknown as {
      createOllamaProvider: (input: Record<string, unknown>) => ProviderInstance;
      changeOllamaConfiguration: (
        provider: Extract<ProviderInstance, { driverKind: "ollama" }>,
        configuration: Record<string, unknown>,
        updatedAt: UtcTimestamp,
        activeSessionCount?: number,
      ) => ProviderInstance;
    };
    const created = policy.createOllamaProvider({
      id: ids.local,
      displayName: "  Ollama local  ",
      configuration: { kind: "ollama-native-http", baseUrl: " http://localhost:11434 " },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(created).toEqual({
      ...ollamaProvider(),
      configuration: { kind: "ollama-native-http", baseUrl: "http://localhost:11434" },
    });
    expect(
      policy.changeOllamaConfiguration(
        ollamaProvider(),
        { kind: "ollama-native-http", baseUrl: "http://[::1]:11434/" },
        updatedAt,
      ),
    ).toMatchObject({
      configuration: { kind: "ollama-native-http", baseUrl: "http://[::1]:11434" },
      version: 2,
      updatedAt,
    });
    for (const baseUrl of [
      "https://ollama.com",
      "http://192.168.1.20:11434",
      "http://127.0.0.2:11434",
      "http://localhost:11434/api",
      "http://localhost:11434/api/v1",
      "http://user@localhost:11434",
      "http://localhost:11434?x=1",
      "http://localhost:11434#x",
    ]) {
      expect(() =>
        policy.createOllamaProvider({
          id: ids.local,
          displayName: "Ollama local",
          configuration: { kind: "ollama-native-http", baseUrl },
          existingInstances: [],
          expectedVersion: version(0),
          createdAt,
        }),
      ).toThrow();
    }
    expect(() =>
      policy.changeOllamaConfiguration(
        ollamaProvider(),
        ollamaProvider().configuration,
        updatedAt,
        1,
      ),
    ).toThrow("Stop active sessions before changing this provider endpoint.");
  });

  it("returns an immutable Claude configuration update with a new version and timestamp", () => {
    const original = claudeProvider();
    const changed = changeClaudeConfiguration(original, {
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "  /usr/local/bin/claude  ",
        authentication: "api-key",
      },
      activeSessionCount: 0,
      updatedAt,
    });

    expect(changed).toEqual({
      ...original,
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/usr/local/bin/claude",
        authentication: "api-key",
      },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(claudeProvider());
  });

  it("rejects Claude reconfiguration before changing an instance with active sessions", () => {
    const original = claudeProvider();

    expect(() =>
      changeClaudeConfiguration(original, {
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "bin/claude",
          authentication: "api-key",
        },
        activeSessionCount: 1,
        updatedAt,
      }),
    ).toThrow("Stop active sessions before reconfiguring this provider.");
    expect(original).toEqual(claudeProvider());
  });

  it("requires non-empty unique names after trimming", () => {
    const existing = provider({ id: ids.other, displayName: "OpenCode Local" });

    expect(() =>
      createOpenCodeProvider({
        id: ids.local,
        displayName: "  opencode local ",
        binaryPath: "/opt/homebrew/bin/opencode",
        existingInstances: [existing],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider names must be unique.");
    expect(() =>
      renameProvider(provider(), {
        displayName: "   ",
        existingInstances: [],
        updatedAt,
      }),
    ).toThrow("Provider name cannot be empty.");
  });

  it("requires an absolute executable path when creating or changing a provider", () => {
    expect(() =>
      createOpenCodeProvider({
        id: ids.local,
        displayName: "OpenCode local",
        binaryPath: "bin/opencode",
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider binary path must be absolute.");
    expect(() => changeProviderBinary(provider(), { binaryPath: "./opencode", updatedAt })).toThrow(
      "Provider binary path must be absolute.",
    );
  });

  it("returns complete immutable updates with incremented versions and supplied timestamps", () => {
    const original = provider();
    const renamed = renameProvider(original, {
      displayName: "  Local OpenCode ",
      existingInstances: [original],
      updatedAt,
    });
    const changed = changeProviderBinary(original, {
      binaryPath: "  /usr/local/bin/opencode ",
      updatedAt,
    });
    const disabled = setProviderEnabled(original, { enabled: false, updatedAt });
    const removed = removeProvider(original, { activeSessionCount: 0, updatedAt });

    expect(renamed).toEqual({ ...original, displayName: "Local OpenCode", version: 2, updatedAt });
    expect(changed).toEqual({
      ...original,
      configuration: { kind: "opencode-cli", binaryPath: "/usr/local/bin/opencode" },
      version: 2,
      updatedAt,
    });
    expect(disabled).toEqual({ ...original, enabled: false, version: 2, updatedAt });
    expect(removed).toEqual({ ...original, version: 2, updatedAt });
    expect(original).toEqual(provider());
  });

  it("rejects removing an instance with active sessions", () => {
    expect(() => removeProvider(provider(), { activeSessionCount: 1 })).toThrow(
      "Stop active sessions before removing this provider.",
    );
  });
});

describe("provider defaults and authority", () => {
  it("defaults omitted permission persistence to current-session", () => {
    expect(
      updateProviderDefaults({ permissionPersistence: "project-default", version: version(0) }),
    ).toEqual({ permissionPersistence: "current-session", version: 1 });
  });

  it("preserves an explicit project-default selection", () => {
    expect(
      updateProviderDefaults(
        { permissionPersistence: "current-session", version: version(0) },
        "project-default",
      ),
    ).toEqual({ permissionPersistence: "project-default", version: 1 });
  });

  it("carries an explicit agent-eligible model default pool", () => {
    const agentEligibleModels = [
      { providerInstanceId: ids.local, modelId: decodeProviderModelId("gpt-5.2") },
    ];
    expect(
      updateProviderDefaults(
        { permissionPersistence: "current-session", version: version(0) },
        "current-session",
        undefined,
        agentEligibleModels,
      ),
    ).toEqual({
      permissionPersistence: "current-session",
      agentEligibleModels,
      version: 1,
    });
  });

  it("preserves the stored agent-eligible pool when the update omits it", () => {
    const agentEligibleModels = [
      { providerInstanceId: ids.local, modelId: decodeProviderModelId("gpt-5.2") },
    ];
    expect(
      updateProviderDefaults(
        {
          permissionPersistence: "current-session",
          agentEligibleModels,
          version: version(1),
        },
        "project-default",
      ),
    ).toEqual({
      permissionPersistence: "project-default",
      agentEligibleModels,
      version: 2,
    });
  });

  it("clears the agent-eligible pool with an explicit empty list", () => {
    expect(
      updateProviderDefaults(
        {
          permissionPersistence: "current-session",
          agentEligibleModels: [
            { providerInstanceId: ids.local, modelId: decodeProviderModelId("gpt-5.2") },
          ],
          version: version(1),
        },
        "current-session",
        undefined,
        [],
      ),
    ).toEqual({ permissionPersistence: "current-session", version: 2 });
  });

  it.each([
    ["plan", "full-access", "plan"],
    ["approval-gated", "full-access", "approval-gated"],
    ["full-access", "full-access", "full-access"],
  ] as const)("clamps requested authority", (allowed, requested, expected) => {
    expect(effectiveProviderAuthority({ allowed, requested })).toBe(expected);
  });

  it("keeps provider-neutral authority ordering unchanged for Claude", () => {
    const claude = claudeProvider();

    expect(
      effectiveProviderAuthority({
        allowed: "approval-gated",
        requested: "full-access",
        enabled: claude.enabled,
      }),
    ).toBe("approval-gated");
  });

  it("denies authority for a disabled provider instance", () => {
    expect(() =>
      effectiveProviderAuthority({ allowed: "full-access", requested: "plan", enabled: false }),
    ).toThrow("Enable this provider before starting a session.");
  });

  it("uses typed policy rejections", () => {
    expect(() => removeProvider(provider(), { activeSessionCount: 1 })).toThrow(
      ProviderPolicyRejected,
    );
  });
});
