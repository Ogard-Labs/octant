import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type AcpAgentProviderInstance,
  type AnthropicCompatibleProviderInstance,
  type AzureFoundryProviderInstance,
  type BflImageProviderInstance,
  type GeminiImageProviderInstance,
  type IdeogramImageProviderInstance,
  type OpenAiCompatibleProviderInstance,
  type OpenAiImageProviderInstance,
  type OpenCodeProviderInstance,
  type ProviderInstance,
} from "@octant/contracts/providers";
import { describe, expect, it } from "vitest";
import {
  ProviderPolicyRejected,
  changeAcpAgentConfiguration,
  createAcpAgentProvider,
  isAcpAgentInstance,
  changeAnthropicCompatibleConfiguration,
  changeAzureFoundryConfiguration,
  changeBflImageConfiguration,
  changeClaudeConfiguration,
  changeGeminiImageConfiguration,
  changeIdeogramImageConfiguration,
  changeOpenAiCompatibleConfiguration,
  changeOpenAiImageConfiguration,
  changeProviderBinary,
  createAnthropicCompatibleProvider,
  createAzureFoundryProvider,
  createBflImageProvider,
  assignedClaudeAccountConfigDirectory,
  effectiveClaudeAccountConfigDirectory,
  createClaudeProvider,
  setClaudeArtifactDelivery,
  formatClaudeAuthLoginCommand,
  createGeminiImageProvider,
  createIdeogramImageProvider,
  createOpenAiCompatibleProvider,
  createOpenAiImageProvider,
  createCodexProvider,
  createOpenCodeProvider,
  createOutsideHarnessEndpointProvider,
  effectiveProviderAuthority,
  rebindOutsideHarnessEndpointDriver,
  isImageProfileDriverKind,
  removeProvider,
  renameProvider,
  setProviderEnabled,
  normalizeOpenAiCompatibleBaseUrl,
  providerCliUpdateArgs,
  supportsProviderCliUpdate,
  updateProviderDefaults,
  type AzureFoundryConfigurationInput,
} from "./providerPolicy";
import * as providerPolicy from "./providerPolicy";

/** The ACP agent policy, taking the loosely typed input these tests probe it with. */
const acpPolicy = providerPolicy as unknown as {
  createAcpAgentProvider: (input: Record<string, unknown>) => AcpAgentProviderInstance;
  changeAcpAgentConfiguration: (
    provider: AcpAgentProviderInstance,
    configuration: Record<string, unknown>,
    updatedAt: UtcTimestamp,
    activeSessionCount?: number,
  ) => AcpAgentProviderInstance;
};

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

function bflImageProvider(overrides: Record<string, unknown> = {}): BflImageProviderInstance {
  const instance = decodeProviderInstance({
    id: ids.local,
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
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  if (instance.driverKind !== "bfl-image") {
    throw new Error("expected BFL image provider fixture");
  }
  return instance;
}

function ideogramImageProvider(
  overrides: Record<string, unknown> = {},
): IdeogramImageProviderInstance {
  const instance = decodeProviderInstance({
    id: ids.local,
    displayName: "Ideogram",
    driverKind: "ideogram-image",
    configuration: {
      kind: "ideogram-image-http",
      modelAllowlist: ["ideogram-v3", "ideogram-v4"],
      defaultModel: "ideogram-v3",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
  if (instance.driverKind !== "ideogram-image") {
    throw new Error("expected Ideogram image provider fixture");
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

function kimiCodeProvider(): AcpAgentProviderInstance {
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
  if (!isAcpAgentInstance(instance)) throw new Error("expected Kimi Code provider fixture");
  return instance;
}

function mistralVibeProvider(): AcpAgentProviderInstance {
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
  if (!isAcpAgentInstance(instance)) throw new Error("expected Mistral Vibe provider fixture");
  return instance;
}

function grokProvider(): AcpAgentProviderInstance {
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
  if (!isAcpAgentInstance(instance)) throw new Error("expected Grok Build provider fixture");
  return instance;
}

function devinProvider(): AcpAgentProviderInstance {
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
  if (!isAcpAgentInstance(instance)) throw new Error("expected Devin provider fixture");
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

const dualAuthCliProviders = [
  {
    label: "GLM Agent",
    kind: "glm-acp",
    displayName: "GLM local",
    binaryPath: "/Users/example/.local/bin/glm-acp-agent",
    updatedBinaryPath: "/opt/homebrew/bin/glm-acp-agent",
    rejection: "GLM Agent authentication must be provider-owned or api-key.",
  },
  {
    label: "Gemini CLI",
    kind: "gemini-acp",
    displayName: "Gemini local",
    binaryPath: "/Users/example/.local/bin/gemini",
    updatedBinaryPath: "/opt/homebrew/bin/gemini",
    rejection: "Gemini CLI authentication must be provider-owned or api-key.",
  },
  {
    label: "Cline",
    kind: "cline-acp",
    displayName: "Cline local",
    binaryPath: "/Users/example/.local/bin/cline",
    updatedBinaryPath: "/opt/homebrew/bin/cline",
    rejection: "Cline authentication must be provider-owned or api-key.",
  },
  {
    label: "Qwen Code",
    kind: "qwen-acp",
    displayName: "Qwen local",
    binaryPath: "/Users/example/.local/bin/qwen",
    updatedBinaryPath: "/opt/homebrew/bin/qwen",
    rejection: "Qwen Code authentication must be provider-owned or api-key.",
  },
] as const;

type DualAuthCliKind = (typeof dualAuthCliProviders)[number]["kind"];
type DualAuthCliMode = "provider-owned" | "api-key";

function createDualAuthCliProvider(
  kind: DualAuthCliKind,
  authentication: DualAuthCliMode,
  binaryPath: string,
  displayName: string,
) {
  return createAcpAgentProvider({
    id: ids.local,
    displayName,
    existingInstances: [],
    expectedVersion: version(0),
    createdAt,
    configuration: { kind, binaryPath, authentication },
  });
}

function changeDualAuthCliConfiguration(
  instance: ReturnType<typeof createDualAuthCliProvider>,
  authentication: DualAuthCliMode,
  binaryPath: string,
) {
  return changeAcpAgentConfiguration(
    instance,
    { kind: instance.configuration.kind, binaryPath, authentication },
    updatedAt,
  );
}

function createDualAuthCliProviderWithInvalidAuthentication(
  kind: DualAuthCliKind,
  binaryPath: string,
  displayName: string,
) {
  return createAcpAgentProvider({
    id: ids.local,
    displayName,
    existingInstances: [],
    expectedVersion: version(0),
    createdAt,
    configuration: { kind, binaryPath, authentication: "subscription" },
  });
}

describe("provider CLI update policy", () => {
  it("keeps update command support shared by server and renderer", () => {
    expect(providerCliUpdateArgs("devin")).toEqual(["update"]);
    expect(providerCliUpdateArgs("kimi-code")).toEqual(["upgrade"]);
    expect(providerCliUpdateArgs("codex")).toEqual(["update"]);
    expect(providerCliUpdateArgs("claude")).toEqual(["update"]);
    expect(providerCliUpdateArgs("opencode")).toBeUndefined();
    expect(supportsProviderCliUpdate("opencode")).toBe(false);
    expect(supportsProviderCliUpdate("copilot")).toBe(true);
    expect(supportsProviderCliUpdate("gemini")).toBe(false);
    expect(supportsProviderCliUpdate("goose")).toBe(false);
    expect(providerCliUpdateArgs("openai-compatible")).toBeUndefined();
  });
});

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

  it("creates gateways that sign in with the organization's own issuer, and keeps that issuer for the life of the endpoint", () => {
    const directory = {
      issuer: "https://login.example.test/oauth2/gateway",
      clientId: "0oa1octantDesktop",
      scope: "gateway.models",
    };
    const gateway = {
      kind: "openai-compatible-http",
      baseUrl: "https://llm.example.test/v1",
      authentication: "directory-oauth",
      protocol: "auto",
      manualModelIds: [],
      directory,
    } as const;
    const anthropicGateway = {
      kind: "anthropic-compatible-http",
      baseUrl: "https://llm.example.test/anthropic/v1/",
      authentication: "directory-oauth",
      protocol: "auto",
      protocolVersion: "2023-06-01",
      manualModelIds: [],
      directory,
    } as const;
    const openAi = createOpenAiCompatibleProvider({
      id: ids.local,
      displayName: "Gateway",
      configuration: gateway,
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(openAi.configuration).toMatchObject({
      authentication: "directory-oauth",
      baseUrl: "https://llm.example.test/v1/",
      directory,
    });
    const anthropic = createAnthropicCompatibleProvider({
      id: ids.local,
      displayName: "Gateway Messages",
      configuration: anthropicGateway,
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(anthropic.configuration).toMatchObject({ authentication: "directory-oauth", directory });

    // The client, scope, and address may change; the grant is then dropped
    // by the server. The issuer is where the person types their password, so
    // it is fixed when the endpoint is created.
    const changed = changeOpenAiCompatibleConfiguration(
      openAi,
      {
        ...gateway,
        baseUrl: "https://llm-2.example.test/v1/",
        directory: { ...directory, clientId: "0oa1other", scope: "gateway.chat" },
      },
      createdAt,
    );
    expect(changed.configuration).toMatchObject({
      directory: { issuer: directory.issuer, clientId: "0oa1other", scope: "gateway.chat" },
    });
    expect(() =>
      changeOpenAiCompatibleConfiguration(
        openAi,
        { ...gateway, directory: { ...directory, issuer: "https://login.example.test" } },
        createdAt,
      ),
    ).toThrow("issuer is fixed");
    expect(() =>
      changeAnthropicCompatibleConfiguration(
        anthropic,
        {
          ...anthropicGateway,
          directory: { ...directory, issuer: "https://other-login.example.test" },
        },
        createdAt,
      ),
    ).toThrow("issuer is fixed");
    // Switching to or from an organization sign-in would set an issuer after
    // creation, or leave a sign-in the endpoint no longer uses.
    const { directory: _directory, ...withoutDirectory } = gateway;
    expect(() =>
      changeOpenAiCompatibleConfiguration(
        openAi,
        { ...withoutDirectory, authentication: "bearer" },
        createdAt,
      ),
    ).toThrow("issuer is fixed");
    const keyed = createOpenAiCompatibleProvider({
      id: ids.local,
      displayName: "Keyed",
      configuration: { ...withoutDirectory, authentication: "bearer" },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(() => changeOpenAiCompatibleConfiguration(keyed, gateway, createdAt)).toThrow(
      "issuer is fixed",
    );
  });

  it("refuses a gateway organization sign-in without an https issuer and address, a client, and one resource scope", () => {
    const configuration = {
      kind: "openai-compatible-http" as const,
      baseUrl: "https://llm.example.test/v1/",
      authentication: "directory-oauth" as const,
      protocol: "auto" as const,
      manualModelIds: [],
      directory: {
        issuer: "https://login.example.test/oauth2/gateway",
        clientId: "0oa1octantDesktop",
        scope: "gateway.models",
      },
    };
    const create = (change: Record<string, unknown>) => () =>
      createOpenAiCompatibleProvider({
        id: ids.local,
        displayName: "Gateway",
        configuration: { ...configuration, ...change },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      });
    const directory = configuration.directory;
    expect(create({ directory: { ...directory, issuer: "http://login.example.test" } })).toThrow(
      "issuer",
    );
    expect(create({ directory: { ...directory, scope: "openid" } })).toThrow("scope");
    expect(create({ directory: { ...directory, scope: "a b" } })).toThrow("scope");
    expect(create({ directory: { ...directory, clientId: "" } })).toThrow("client");
    // A bearer token never travels over plain http, even to a loopback gateway.
    expect(create({ baseUrl: "http://127.0.0.1:4000/v1/" })).toThrow("HTTPS");
    expect(create({ directory: undefined })).toThrow("issuer");
  });

  it("creates and changes an Azure AI Foundry endpoint that signs in with the organization's directory, keeping its tenant and client", () => {
    const directory = {
      tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
    };
    const configuration = {
      kind: "azure-foundry-openai-http" as const,
      baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
      authentication: "directory-oauth" as const,
      protocol: "auto" as const,
      manualModelIds: ["deployment-a"],
      directory,
    };
    const created = createAzureFoundryProvider({
      id: ids.local,
      displayName: "Azure Foundry Work",
      configuration,
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(created.configuration).toEqual(configuration);

    const { directory: _directory, ...withoutDirectory } = configuration;
    const keyed = changeAzureFoundryConfiguration(
      created,
      { ...withoutDirectory, authentication: "api-key" },
      createdAt,
    );
    expect(keyed.configuration).toEqual({
      kind: "azure-foundry-openai-http",
      baseUrl: configuration.baseUrl,
      authentication: "api-key",
      protocol: "auto",
      manualModelIds: ["deployment-a"],
    });
    const signedIn = changeAzureFoundryConfiguration(keyed, configuration, createdAt);
    expect(signedIn.configuration).toEqual(configuration);
  });

  it("creates an Amazon Bedrock instance from its region and single sign-on, trimming what was pasted", () => {
    const created = providerPolicy.createAmazonBedrockProvider({
      id: ids.local,
      displayName: "Bedrock",
      configuration: {
        kind: "amazon-bedrock-converse-http",
        region: " us-west-2 ",
        authentication: "cloud-iam",
        cloudIam: {
          startUrl: " https://contoso.awsapps.com/start/ ",
          ssoRegion: "us-east-1",
          accountId: " 123456789012",
          roleName: "BedrockInvoke ",
        },
        manualModelIds: [" anthropic.claude-sonnet-4-20250514-v1:0 "],
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(created).toMatchObject({
      driverKind: "amazon-bedrock",
      configuration: {
        region: "us-west-2",
        authentication: "cloud-iam",
        cloudIam: {
          startUrl: "https://contoso.awsapps.com/start",
          ssoRegion: "us-east-1",
          accountId: "123456789012",
          roleName: "BedrockInvoke",
        },
        manualModelIds: ["anthropic.claude-sonnet-4-20250514-v1:0"],
      },
    });
    expect(providerPolicy.isNativeHarnessDriverKind("amazon-bedrock")).toBe(true);
  });

  it("refuses an Amazon Bedrock instance outside the commercial partition, at another portal, or without a model", () => {
    const valid = {
      kind: "amazon-bedrock-converse-http" as const,
      region: "us-west-2",
      authentication: "cloud-iam" as const,
      cloudIam: {
        startUrl: "https://contoso.awsapps.com/start",
        ssoRegion: "us-east-1",
        accountId: "123456789012",
        roleName: "BedrockInvoke",
      },
      manualModelIds: ["anthropic.claude-sonnet-4-20250514-v1:0"],
    };
    const create = (configuration: typeof valid) => () =>
      providerPolicy.createAmazonBedrockProvider({
        id: ids.local,
        displayName: "Bedrock",
        configuration,
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      });
    for (const configuration of [
      { ...valid, region: "us-gov-west-1" },
      { ...valid, region: "cn-northwest-1" },
      { ...valid, cloudIam: { ...valid.cloudIam, ssoRegion: "us-gov-east-1" } },
      { ...valid, cloudIam: { ...valid.cloudIam, startUrl: "https://contoso.example/start" } },
      { ...valid, cloudIam: { ...valid.cloudIam, accountId: "1234" } },
      { ...valid, cloudIam: { ...valid.cloudIam, roleName: "role name" } },
      { ...valid, manualModelIds: [] },
      { ...valid, manualModelIds: ["model id with spaces"] },
    ]) {
      expect(create(configuration)).toThrow(ProviderPolicyRejected);
    }
  });

  it("refuses a directory sign-in without GUID tenant and client ids, or at an address off the Foundry hosts", () => {
    const unbound: AzureFoundryConfigurationInput = {
      kind: "azure-foundry-openai-http",
      baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
      authentication: "directory-oauth",
      protocol: "auto",
      manualModelIds: ["deployment-a"],
    };
    const create = (configuration: Partial<AzureFoundryConfigurationInput>) => () =>
      createAzureFoundryProvider({
        id: ids.local,
        displayName: "Azure Foundry Work",
        configuration: {
          ...unbound,
          directory: {
            tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
            clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
          },
          ...configuration,
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      });
    const guids = "each a GUID";
    expect(() =>
      createAzureFoundryProvider({
        id: ids.local,
        displayName: "Azure Foundry Work",
        configuration: unbound,
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow(guids);
    expect(
      create({
        directory: { tenantId: "common", clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d" },
      }),
    ).toThrow(guids);
    expect(
      create({
        directory: {
          tenantId: "6F1C2D3E-4A5B-4C6D-8E7F-9A0B1C2D3E4F",
          clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
        },
      }),
    ).toThrow(guids);
    expect(create({ baseUrl: "https://models.example.com/openai/v1/" })).toThrow(
      "under openai.azure.com",
    );
    // An API-key endpoint names no tenant.
    expect(create({ authentication: "api-key" })).toThrow("does not name a directory tenant");
  });

  it("keeps a device-code sign-in only as an organization sign-in's explicit opt-in", () => {
    const configuration: AzureFoundryConfigurationInput = {
      kind: "azure-foundry-openai-http",
      baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
      authentication: "directory-oauth",
      protocol: "auto",
      manualModelIds: ["deployment-a"],
      directory: {
        tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
        clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
      },
    };
    const create = (input: AzureFoundryConfigurationInput) =>
      createAzureFoundryProvider({
        id: ids.local,
        displayName: "Azure Foundry headless",
        configuration: input,
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      });

    const optedIn = create({ ...configuration, deviceCodeSignIn: true });
    expect(optedIn.configuration).toMatchObject({ deviceCodeSignIn: true });
    // Off is stored as the absence of the opt-in, never as `false`.
    const optedOut = changeAzureFoundryConfiguration(
      optedIn,
      { ...configuration, deviceCodeSignIn: false },
      createdAt,
    );
    expect(optedOut.configuration).not.toHaveProperty("deviceCodeSignIn");
    expect(create(configuration).configuration).not.toHaveProperty("deviceCodeSignIn");
    // An API-key endpoint has no organization sign-in to begin with a code.
    const { directory: _directory, ...keyed } = configuration;
    expect(() => create({ ...keyed, authentication: "api-key", deviceCodeSignIn: true })).toThrow(
      "device code",
    );
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

  it("creates a BFL image profile with a normalized allowlist and default model", () => {
    expect(
      createBflImageProvider({
        id: ids.local,
        displayName: "  FLUX  ",
        configuration: {
          kind: "bfl-image-http",
          modelAllowlist: [" flux-pro-1.1 ", "flux-pro-1.1", " flux-dev "],
          defaultModel: " flux-pro-1.1 ",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(
      bflImageProvider({
        displayName: "FLUX",
        configuration: {
          kind: "bfl-image-http",
          modelAllowlist: ["flux-pro-1.1", "flux-dev"],
          defaultModel: "flux-pro-1.1",
        },
      }),
    );
  });

  it("keeps a BFL or Ideogram image profile's own base URL only when it is HTTPS or loopback", () => {
    const bfl = createBflImageProvider({
      id: ids.local,
      displayName: "FLUX proxy",
      configuration: {
        kind: "bfl-image-http",
        modelAllowlist: ["flux-dev"],
        defaultModel: "flux-dev",
        baseUrl: " https://proxy.example.test/bfl ",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(bfl.configuration.baseUrl).toBe("https://proxy.example.test/bfl/");
    const ideogram = createIdeogramImageProvider({
      id: ids.local,
      displayName: "Ideogram local",
      configuration: {
        kind: "ideogram-image-http",
        modelAllowlist: ["ideogram-v3"],
        defaultModel: "ideogram-v3",
        baseUrl: "http://127.0.0.1:8080",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(ideogram.configuration.baseUrl).toBe("http://127.0.0.1:8080/");
    expect(() =>
      createBflImageProvider({
        id: ids.local,
        displayName: "FLUX",
        configuration: {
          kind: "bfl-image-http",
          modelAllowlist: ["flux-dev"],
          defaultModel: "flux-dev",
          baseUrl: "http://proxy.example.test",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider base URL must use HTTPS or loopback HTTP.");
  });

  it("rejects a BFL image profile whose default model is not in the allowlist", () => {
    expect(() =>
      createBflImageProvider({
        id: ids.local,
        displayName: "FLUX",
        configuration: {
          kind: "bfl-image-http",
          modelAllowlist: ["flux-pro-1.1"],
          defaultModel: "flux-dev",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Default model must be a member of the model allowlist.");
  });

  it("rejects a BFL image profile with no model IDs", () => {
    expect(() =>
      createBflImageProvider({
        id: ids.local,
        displayName: "FLUX",
        configuration: {
          kind: "bfl-image-http",
          modelAllowlist: [],
          defaultModel: "flux-pro-1.1",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Image profiles require at least one model ID.");
  });

  it("returns a complete immutable BFL image configuration update", () => {
    const original = bflImageProvider();
    const changed = changeBflImageConfiguration(
      original,
      {
        kind: "bfl-image-http",
        modelAllowlist: [" flux-dev ", "flux-dev"],
        defaultModel: " flux-dev ",
      },
      updatedAt,
    );

    expect(changed).toEqual({
      ...original,
      configuration: {
        kind: "bfl-image-http",
        modelAllowlist: ["flux-dev"],
        defaultModel: "flux-dev",
      },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(bflImageProvider());
  });

  it("creates an Ideogram image profile with a normalized allowlist and default model", () => {
    expect(
      createIdeogramImageProvider({
        id: ids.local,
        displayName: "  Ideogram  ",
        configuration: {
          kind: "ideogram-image-http",
          modelAllowlist: [" ideogram-v3 ", "ideogram-v3", " ideogram-v4 "],
          defaultModel: " ideogram-v3 ",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toEqual(
      ideogramImageProvider({
        displayName: "Ideogram",
        configuration: {
          kind: "ideogram-image-http",
          modelAllowlist: ["ideogram-v3", "ideogram-v4"],
          defaultModel: "ideogram-v3",
        },
      }),
    );
  });

  it("rejects an Ideogram image profile whose default model is not in the allowlist", () => {
    expect(() =>
      createIdeogramImageProvider({
        id: ids.local,
        displayName: "Ideogram",
        configuration: {
          kind: "ideogram-image-http",
          modelAllowlist: ["ideogram-v3"],
          defaultModel: "ideogram-v4",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Default model must be a member of the model allowlist.");
  });

  it("rejects an Ideogram image profile with no model IDs", () => {
    expect(() =>
      createIdeogramImageProvider({
        id: ids.local,
        displayName: "Ideogram",
        configuration: {
          kind: "ideogram-image-http",
          modelAllowlist: [],
          defaultModel: "ideogram-v3",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Image profiles require at least one model ID.");
  });

  it("returns a complete immutable Ideogram image configuration update", () => {
    const original = ideogramImageProvider();
    const changed = changeIdeogramImageConfiguration(
      original,
      {
        kind: "ideogram-image-http",
        modelAllowlist: [" ideogram-v4 ", "ideogram-v4"],
        defaultModel: " ideogram-v4 ",
      },
      updatedAt,
    );

    expect(changed).toEqual({
      ...original,
      configuration: {
        kind: "ideogram-image-http",
        modelAllowlist: ["ideogram-v4"],
        defaultModel: "ideogram-v4",
      },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(ideogramImageProvider());
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
    expect(isImageProfileDriverKind("bfl-image")).toBe(true);
    expect(isImageProfileDriverKind("ideogram-image")).toBe(true);
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
      createAcpAgentProvider({
        id: ids.local,
        displayName: "Kimi Code local",
        configuration: { kind: "kimi-code-acp", binaryPath: "/opt/homebrew/bin/kimi" },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }).enabled,
    ).toBe(true);
  });

  it("creates and immutably updates a Kimi Code instance with an absolute binary path", () => {
    const original = createAcpAgentProvider({
      id: ids.local,
      displayName: "  Kimi Code local ",
      configuration: { kind: "kimi-code-acp", binaryPath: " /opt/homebrew/bin/kimi " },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });

    expect(original).toEqual(kimiCodeProvider());
    expect(
      changeAcpAgentConfiguration(
        original,
        { kind: "kimi-code-acp", binaryPath: " /usr/local/bin/kimi " },
        updatedAt,
      ),
    ).toEqual({
      ...original,
      configuration: { kind: "kimi-code-acp", binaryPath: "/usr/local/bin/kimi" },
      version: 2,
      updatedAt,
    });
    expect(original).toEqual(kimiCodeProvider());

    expect(() =>
      createAcpAgentProvider({
        id: ids.local,
        displayName: "Kimi Code local",
        configuration: { kind: "kimi-code-acp", binaryPath: "bin/kimi" },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider binary path must be absolute.");
  });

  it("rejects a Kimi Code binary change while sessions are active", () => {
    const original = kimiCodeProvider();
    expect(() =>
      changeAcpAgentConfiguration(
        original,
        { kind: "kimi-code-acp", binaryPath: "/usr/local/bin/kimi" },
        updatedAt,
        1,
      ),
    ).toThrow("Stop active sessions before changing this provider runtime.");
    expect(original).toEqual(kimiCodeProvider());
  });

  it("refuses to move an ACP agent instance onto another agent's configuration", () => {
    expect(() =>
      changeAcpAgentConfiguration(
        kimiCodeProvider(),
        { kind: "kilo-acp", binaryPath: "/usr/local/bin/kilo" },
        updatedAt,
      ),
    ).toThrow("The configuration names a different provider runtime.");
  });

  it("refuses a posture on an ACP agent whose profile lists none", () => {
    expect(() =>
      acpPolicy.createAcpAgentProvider({
        id: ids.local,
        displayName: "Kilo local",
        configuration: { kind: "kilo-acp", binaryPath: "/bin/kilo", authentication: "api-key" },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Kilo takes no authentication setting.");
  });

  it("assigns a Claude-owned account directory under the home folder", () => {
    expect(assignedClaudeAccountConfigDirectory("/Users/example/", ids.local)).toBe(
      `/Users/example/.claude-accounts/${ids.local}`,
    );
    expect(assignedClaudeAccountConfigDirectory("/Users/example////", ids.local)).toBe(
      `/Users/example/.claude-accounts/${ids.local}`,
    );
  });

  it("launches an API-key Claude account from its assigned folder even when none is stored", () => {
    const subscription = claudeProvider();
    const apiKey = {
      ...subscription,
      configuration: { ...subscription.configuration, authentication: "api-key" as const },
    };
    const stored = {
      ...apiKey,
      configuration: { ...apiKey.configuration, configDirectory: "/Users/example/custom" },
    };

    expect(effectiveClaudeAccountConfigDirectory(subscription, "/Users/example")).toBeUndefined();
    expect(effectiveClaudeAccountConfigDirectory(apiKey, "/Users/example")).toBe(
      assignedClaudeAccountConfigDirectory("/Users/example", apiKey.id),
    );
    expect(effectiveClaudeAccountConfigDirectory(stored, "/Users/example")).toBe(
      "/Users/example/custom",
    );
  });

  it("refuses a Windows or relative home when assigning a Claude account directory", () => {
    expect(() => assignedClaudeAccountConfigDirectory("C:\\Users\\example", ids.local)).toThrow(
      "Claude account home must be an absolute directory.",
    );
    expect(() => assignedClaudeAccountConfigDirectory("Users/example", ids.local)).toThrow(
      "Claude account home must be an absolute directory.",
    );
  });

  it("formats the unmodified Claude sign-in command for an isolated account", () => {
    expect(
      formatClaudeAuthLoginCommand({
        binaryPath: "  /opt/homebrew/bin/claude  ",
        configDirectory: "/Users/example/.claude-accounts/work",
      }),
    ).toBe(
      "CLAUDE_CONFIG_DIR='/Users/example/.claude-accounts/work' CLAUDE_SECURESTORAGE_CONFIG_DIR='/Users/example/.claude-accounts/work' '/opt/homebrew/bin/claude' auth login",
    );
  });

  it("refuses a Claude config directory that names a credential file", () => {
    expect(() =>
      createClaudeProvider({
        id: ids.local,
        displayName: "Claude local",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
          configDirectory: "/Users/example/.claude/.credentials.json",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Claude config directory cannot be a credential file.");
    expect(() =>
      createClaudeProvider({
        id: ids.local,
        displayName: "Claude local",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
          configDirectory: "/Users/example/.claude/.credentials.json////",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Claude config directory cannot be a credential file.");
  });

  it("refuses a Windows or relative Claude config directory", () => {
    expect(() =>
      createClaudeProvider({
        id: ids.local,
        displayName: "Claude local",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
          configDirectory: "C:\\Users\\example\\.claude-accounts\\work",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Claude config directory must be an absolute path.");
  });

  it("creates a Claude account with a config directory and accent", () => {
    expect(
      createClaudeProvider({
        id: ids.local,
        displayName: "Work Claude",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
          configDirectory: "/Users/example/.claude-accounts/work",
          accent: "teal",
        },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toMatchObject({
      displayName: "Work Claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
        configDirectory: "/Users/example/.claude-accounts/work",
        accent: "teal",
      },
    });
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
    const original = acpPolicy.createAcpAgentProvider({
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
      acpPolicy.changeAcpAgentConfiguration(
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
    expect(() =>
      acpPolicy.createAcpAgentProvider({
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
      acpPolicy.createAcpAgentProvider({
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
      acpPolicy.changeAcpAgentConfiguration(
        mistralVibeProvider(),
        mistralVibeProvider().configuration,
        updatedAt,
        1,
      ),
    ).toThrow("Stop active sessions before changing this provider runtime.");
  });

  it("creates and immutably updates Grok Build with explicit selected authentication", () => {
    const original = acpPolicy.createAcpAgentProvider({
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
      acpPolicy.changeAcpAgentConfiguration(
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
    expect(() =>
      acpPolicy.createAcpAgentProvider({
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
      acpPolicy.createAcpAgentProvider({
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
      acpPolicy.changeAcpAgentConfiguration(
        grokProvider(),
        grokProvider().configuration,
        updatedAt,
        1,
      ),
    ).toThrow("Stop active sessions before changing this provider runtime.");
  });

  it("creates and immutably updates Goose with provider-owned configuration", () => {
    const original = acpPolicy.createAcpAgentProvider({
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

  it.each(
    dualAuthCliProviders.flatMap((provider) =>
      (["provider-owned", "api-key"] as const).map((authentication) => ({
        ...provider,
        authentication,
      })),
    ),
  )(
    "creates and immutably updates $label with $authentication authentication",
    ({ kind, displayName, binaryPath, updatedBinaryPath, authentication }) => {
      const original = createDualAuthCliProvider(
        kind,
        authentication,
        ` ${binaryPath} `,
        `  ${displayName}  `,
      );
      expect(original.configuration).toEqual({
        kind,
        binaryPath,
        authentication,
      });
      expect(original.displayName).toBe(displayName);

      const changed = changeDualAuthCliConfiguration(original, authentication, updatedBinaryPath);
      expect(changed).toEqual({
        ...original,
        configuration: {
          kind,
          binaryPath: updatedBinaryPath,
          authentication,
        },
        version: 2,
        updatedAt,
      });
      expect(original.configuration).toEqual({
        kind,
        binaryPath,
        authentication,
      });
    },
  );

  it.each(dualAuthCliProviders)(
    "refuses $label authentication that is neither provider-owned nor api-key",
    ({ kind, binaryPath, displayName, rejection }) => {
      expect(() =>
        createDualAuthCliProviderWithInvalidAuthentication(kind, binaryPath, displayName),
      ).toThrow(rejection);
    },
  );

  it.each(dualAuthCliProviders)(
    "keeps the selected $label authentication when an update switches from api-key to provider-owned",
    ({ kind, displayName, binaryPath, updatedBinaryPath }) => {
      const original = createDualAuthCliProvider(kind, "api-key", binaryPath, displayName);
      const changed = changeDualAuthCliConfiguration(original, "provider-owned", updatedBinaryPath);
      expect(changed.configuration.authentication).toBe("provider-owned");
      expect(original.configuration.authentication).toBe("api-key");
    },
  );

  it("creates and immutably updates GitHub Copilot with provider-owned configuration", () => {
    const original = acpPolicy.createAcpAgentProvider({
      id: ids.local,
      displayName: "  Copilot local  ",
      configuration: {
        kind: "copilot-acp",
        binaryPath: " /Users/example/.local/bin/copilot ",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(original.configuration).toEqual({
      kind: "copilot-acp",
      binaryPath: "/Users/example/.local/bin/copilot",
    });
  });

  it("creates and immutably updates Devin with subscription authentication", () => {
    const original = acpPolicy.createAcpAgentProvider({
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
      acpPolicy.changeAcpAgentConfiguration(
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
    expect(() =>
      acpPolicy.createAcpAgentProvider({
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
      acpPolicy.createAcpAgentProvider({
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
      acpPolicy.changeAcpAgentConfiguration(
        devinProvider(),
        devinProvider().configuration,
        updatedAt,
        1,
      ),
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
    const original = acpPolicy.createAcpAgentProvider({
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
    const updated = acpPolicy.changeAcpAgentConfiguration(
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
      acpPolicy.createAcpAgentProvider({
        id: ids.local,
        displayName: "Kilo local",
        configuration: { kind: "kilo-acp", binaryPath: "bin/kilo" },
        existingInstances: [],
        expectedVersion: version(0),
        createdAt,
      }),
    ).toThrow("Provider binary path must be absolute.");
    expect(() =>
      acpPolicy.changeAcpAgentConfiguration(original, original.configuration, updatedAt, 1),
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

  it("keeps a Claude account pinned to the config directory and accent it was given", () => {
    const original = createClaudeProvider({
      id: ids.local,
      displayName: "Work Claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
        configDirectory: "/Users/example/.claude-accounts/work",
        accent: "teal",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    const changed = changeClaudeConfiguration(original, {
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/usr/local/bin/claude",
        authentication: "subscription",
        configDirectory: "/Users/example/.claude-accounts/work",
        accent: "rose",
      },
      activeSessionCount: 0,
      updatedAt,
    });
    expect(changed.configuration.configDirectory).toBe("/Users/example/.claude-accounts/work");
    expect(changed.configuration.accent).toBe("rose");
    expect(original.configuration.accent).toBe("teal");

    const renamed = renameProvider(original, {
      displayName: "Personal Claude",
      existingInstances: [original],
      updatedAt,
    });
    expect(renamed.displayName).toBe("Personal Claude");
    expect(renamed.configuration).toEqual(original.configuration);

    const disabled = setProviderEnabled(original, { enabled: false, updatedAt });
    expect(disabled.enabled).toBe(false);
    expect(disabled.configuration).toEqual(original.configuration);

    const removed = removeProvider(original, { activeSessionCount: 0, updatedAt });
    expect(removed.configuration).toEqual(original.configuration);
    expect(
      removed.driverKind === "claude" ? removed.configuration.configDirectory : undefined,
    ).toBe("/Users/example/.claude-accounts/work");
  });

  it("keeps an isolated Claude directory when a later save omits it", () => {
    const original = createClaudeProvider({
      id: ids.local,
      displayName: "Work Claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
        configDirectory: "/Users/example/.claude-accounts/work",
        accent: "teal",
      },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    const changed = changeClaudeConfiguration(original, {
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/usr/local/bin/claude",
        authentication: "subscription",
        accent: "rose",
      },
      activeSessionCount: 0,
      updatedAt,
    });
    expect(changed.configuration.configDirectory).toBe("/Users/example/.claude-accounts/work");
    expect(changed.configuration.accent).toBe("rose");
    expect(changed.configuration.binaryPath).toBe("/usr/local/bin/claude");
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

  it("recolours a Claude account that has active sessions, because no process reads the accent", () => {
    const original = claudeProvider();

    const changed = changeClaudeConfiguration(original, {
      configuration: { ...original.configuration, accent: "rose" },
      activeSessionCount: 1,
      updatedAt,
    });

    expect(changed.configuration).toEqual({ ...original.configuration, accent: "rose" });
    expect(changed.version).toBe(2);
  });

  it("turns Claude artifacts on only by the person's own switch and only for a claude.ai sign-in", () => {
    const subscription = changeClaudeConfiguration(claudeProvider(), {
      configuration: { ...claudeProvider().configuration, authentication: "subscription" },
      activeSessionCount: 0,
      updatedAt,
    });
    // A running session is no reason to refuse: the switch changes no process input.
    const on = setClaudeArtifactDelivery(subscription, { enabled: true, updatedAt });
    expect(on.configuration.artifactDelivery).toBe(true);
    expect(on.version).toBe(subscription.version + 1);

    // An account edit keeps the person's switch and cannot set it itself.
    const recoloured = changeClaudeConfiguration(on, {
      configuration: { ...subscription.configuration, accent: "rose" },
      activeSessionCount: 1,
      updatedAt,
    });
    expect(recoloured.configuration.artifactDelivery).toBe(true);
    const created = createClaudeProvider({
      id: ids.other,
      displayName: "Second Claude",
      configuration: { ...on.configuration, configDirectory: "/Users/example/.claude-accounts/b" },
      existingInstances: [],
      expectedVersion: version(0),
      createdAt,
    });
    expect(created.configuration).not.toHaveProperty("artifactDelivery");

    // An API key has no claude.ai account: moving to one turns the switch off,
    // and it cannot be turned on there.
    const keyed = changeClaudeConfiguration(on, {
      configuration: { ...subscription.configuration, authentication: "api-key" },
      activeSessionCount: 0,
      updatedAt,
    });
    expect(keyed.configuration).not.toHaveProperty("artifactDelivery");
    expect(() => setClaudeArtifactDelivery(keyed, { enabled: true, updatedAt })).toThrow(
      "Claude artifacts need a claude.ai sign-in",
    );

    const off = setClaudeArtifactDelivery(on, { enabled: false, updatedAt });
    expect(off.configuration).not.toHaveProperty("artifactDelivery");
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

describe("outside driver provider policy", () => {
  const createdAt = "2026-10-27T12:00:00.000Z" as UtcTimestamp;
  const driver = {
    extensionId: "00000000-0000-4000-8000-000000000911",
    packageId: "00000000-0000-4000-8000-000000000912",
    componentId: "driver",
    version: "0.1.0",
    digest: `sha256:${"c".repeat(64)}`,
  } as const;
  const create = (configuration: Record<string, unknown>, existingInstances = []) =>
    createOutsideHarnessEndpointProvider({
      id: decodeProviderInstanceId("00000000-0000-4000-8000-000000000913"),
      displayName: " Team models ",
      configuration: {
        kind: "outside-harness-endpoint",
        driver,
        baseUrl: "https://models.example.test/v1",
        key: { header: "authorization", scheme: "Bearer" },
        modelIds: [decodeProviderModelId("model-a")],
        ...configuration,
      } as never,
      existingInstances,
      expectedVersion: 0 as AggregateVersion,
      createdAt,
    });

  it("adds the provider off, bound to the exact package, with its address normalized", () => {
    const instance = create({});
    expect(decodeProviderInstance(instance)).toEqual(instance);
    expect(instance).toMatchObject({
      displayName: "Team models",
      driverKind: "outside-harness-endpoint",
      enabled: false,
      version: 1,
      configuration: {
        driver,
        baseUrl: "https://models.example.test/v1/",
        key: { header: "authorization", scheme: "Bearer" },
        modelIds: ["model-a"],
      },
    });
  });

  it("refuses an address that is not HTTPS or loopback HTTP, and a keyless address off loopback", () => {
    expect(() => create({ baseUrl: "http://models.example.test/" })).toThrow(
      ProviderPolicyRejected,
    );
    expect(() => create({ baseUrl: "https://user:secret@models.example.test/" })).toThrow(
      ProviderPolicyRejected,
    );
    expect(() => create({ key: undefined })).toThrow(
      "Unauthenticated providers must use a loopback endpoint.",
    );
    const { key: _key, ...keyless } = create({ baseUrl: "http://127.0.0.1:8080" }).configuration;
    expect(create({ baseUrl: "http://127.0.0.1:8080", key: undefined }).configuration).toEqual(
      keyless,
    );
  });

  const reboundAt = "2026-10-28T09:00:00.000Z" as UtcTimestamp;

  it("moves a provider to its driver's newly trusted digest and keeps everything else the person set", () => {
    const instance = { ...create({}), enabled: true };
    const newer = { ...driver, version: "0.2.0", digest: `sha256:${"d".repeat(64)}` };
    const rebound = rebindOutsideHarnessEndpointDriver(instance, newer as never, reboundAt);
    expect(decodeProviderInstance(rebound)).toEqual(rebound);
    expect(rebound).toEqual({
      ...instance,
      configuration: { ...instance.configuration, driver: newer },
      version: 2,
      updatedAt: reboundAt,
    });
  });

  it("refuses to move a provider to another package or another component", () => {
    const instance = create({});
    expect(() =>
      rebindOutsideHarnessEndpointDriver(
        instance,
        { ...driver, packageId: "00000000-0000-4000-8000-000000000914" } as never,
        reboundAt,
      ),
    ).toThrow(ProviderPolicyRejected);
    expect(() =>
      rebindOutsideHarnessEndpointDriver(
        instance,
        { ...driver, componentId: "other-driver" } as never,
        reboundAt,
      ),
    ).toThrow(ProviderPolicyRejected);
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

  it("persists hidden model defaults and preserves them when omitted", () => {
    const hiddenModels = [
      { providerInstanceId: ids.local, modelId: decodeProviderModelId("gpt-5.2") },
    ];
    const updated = updateProviderDefaults(
      { permissionPersistence: "current-session", version: version(0) },
      "current-session",
      undefined,
      undefined,
      hiddenModels,
    );
    expect(updated).toEqual({ permissionPersistence: "current-session", hiddenModels, version: 1 });
    expect(updateProviderDefaults(updated, "project-default")).toEqual({
      permissionPersistence: "project-default",
      hiddenModels,
      version: 2,
    });
  });

  it("clears hidden model defaults with an explicit empty list", () => {
    const hiddenModels = [
      { providerInstanceId: ids.local, modelId: decodeProviderModelId("gpt-5.2") },
    ];
    expect(
      updateProviderDefaults(
        { permissionPersistence: "current-session", hiddenModels, version: version(1) },
        "current-session",
        undefined,
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
