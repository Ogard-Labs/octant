import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  type ProviderInstance,
} from "@octant/contracts";
import { BUNDLED_PROVIDER_DRIVER_PLUGINS } from "@octant/plugin-host/provider-drivers";
import { DISCOVERY_DESCRIPTORS } from "@octant/provider-sdk/discovery";
import { isAcpHostProfileDriver } from "@octant/provider-sdk/driver-plugins";
import { providerKeepsConversation } from "@octant/domain";
import { Effect } from "effect";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { snapshotClaudeHostEnvironment } from "./claudeAccountDirectory";
import type { ClaudeAgentSdkPort } from "./claudeAgentSdkPort";
import type { ClaudeProcessPort } from "./claudeProcess";
import type { CodexProcessPort } from "./codexProcess";
import type { AcpDriverOptions } from "./acpDriver";
import type { AcpProcessPort } from "./acpProcess";
import type { AnthropicCompatibleDriverOptions } from "./anthropicCompatibleDriver";
import type { AzureFoundryDriverOptions } from "./azureFoundryDriver";
import type { ClaudeDriverOptions } from "./claudeDriver";
import type { CodexDriverOptions } from "./codexDriver";
import type { OhMyPiDriverOptions } from "./ohMyPiDriver";
import type { OllamaDriverOptions } from "./ollamaDriver";
import type { OpenAiCompatibleDriverOptions } from "./openAiCompatibleDriver";
import type { OpenCodeDriverOptions } from "./openCodeDriver";
import type { PiDriverOptions } from "./piDriver";
import type { OpenCodeProcessPort } from "./openCodeProcess";
import type { OllamaFetch } from "./ollamaEndpoint";
import type { PiProcessPort } from "./piProcess";
import {
  ProviderDriverConfigurationError,
  makeProviderDriver,
  type ProviderDriverFactoryOptions,
} from "./providerDriverFactory";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000061");
const timestamp = "2026-07-16T10:00:00.000Z";

describe("bundled provider-driver plugins", () => {
  it("registers every discovery descriptor as a provider-driver plugin", () => {
    expect(BUNDLED_PROVIDER_DRIVER_PLUGINS.map((plugin) => plugin.driverKind).sort()).toEqual(
      DISCOVERY_DESCRIPTORS.map((descriptor) => descriptor.driverKind).sort(),
    );
  });

  it("keeps ACP vendors on the host ACP stack", () => {
    expect(
      BUNDLED_PROVIDER_DRIVER_PLUGINS.filter((plugin) =>
        isAcpHostProfileDriver(plugin.driverKind),
      ).map((plugin) => plugin.driverKind),
    ).toEqual([
      "kilo",
      "devin",
      "mistral-vibe",
      "kimi-code",
      "grok",
      "goose",
      "glm",
      "gemini",
      "copilot",
      "cline",
      "qwen",
      "fx",
    ]);
  });
});

describe("driver runtime registries", () => {
  it("give no driver a way to write the host's Verify tools record", () => {
    // Checked by the typechecker: a driver that could write the record would
    // admit Octant's tools for a model no person verified.
    expectTypeOf<OpenAiCompatibleDriverOptions["runtimeRegistry"]>().not.toHaveProperty(
      "setVerifiedToolModels",
    );
    expectTypeOf<AnthropicCompatibleDriverOptions["runtimeRegistry"]>().not.toHaveProperty(
      "setVerifiedToolModels",
    );
    expectTypeOf<AzureFoundryDriverOptions["runtimeRegistry"]>().not.toHaveProperty(
      "setVerifiedToolModels",
    );
    expectTypeOf<OllamaDriverOptions["runtimeRegistry"]>().not.toHaveProperty(
      "setVerifiedToolModels",
    );
    expectTypeOf<ClaudeDriverOptions["runtimeRegistry"]>().not.toHaveProperty(
      "setVerifiedToolModels",
    );
    expectTypeOf<CodexDriverOptions["runtimeRegistry"]>().not.toHaveProperty(
      "setVerifiedToolModels",
    );
    expectTypeOf<AcpDriverOptions["runtimeRegistry"]>().not.toHaveProperty("setVerifiedToolModels");
    expectTypeOf<OpenCodeDriverOptions["runtimeRegistry"]>().not.toHaveProperty(
      "setVerifiedToolModels",
    );
    expectTypeOf<PiDriverOptions["runtimeRegistry"]>().not.toHaveProperty("setVerifiedToolModels");
    expectTypeOf<OhMyPiDriverOptions["runtimeRegistry"]>().not.toHaveProperty(
      "setVerifiedToolModels",
    );
  });
});

describe("makeProviderDriver", () => {
  it("selects the OpenCode process only for an OpenCode instance", async () => {
    const fixture = factoryFixture();
    const driver = makeProviderDriver(provider("opencode"), fixture.options);

    await expect(runProbe(driver)).rejects.toThrow(/OpenCode process selected/);
    expect(fixture.openCodeStart).toHaveBeenCalledOnce();
    expect(fixture.codexStart).not.toHaveBeenCalled();
  });

  it("uses the beta OpenCode catalog process for provider discovery", async () => {
    const fixture = factoryFixture();
    const driver = makeProviderDriver(provider("opencode", "/missing/opencode2"), fixture.options);

    await expect(runProbe(driver)).rejects.toThrow(/OpenCode process selected/);
    expect(fixture.openCodeStart).toHaveBeenCalledOnce();
    expect(fixture.acpStart).not.toHaveBeenCalled();
  });

  it("selects the Codex process only for a Codex instance", async () => {
    const fixture = factoryFixture();
    const driver = makeProviderDriver(provider("codex"), fixture.options);

    await expect(runProbe(driver)).rejects.toThrow(/Codex process selected/);
    expect(fixture.codexStart).toHaveBeenCalledOnce();
    expect(fixture.openCodeStart).not.toHaveBeenCalled();
  });

  it("refuses to construct a Codex driver without the account snapshot", () => {
    const fixture = factoryFixture();
    const { codexInstances: _ignored, ...withoutSnapshot } = fixture.options;

    expect(() => makeProviderDriver(provider("codex"), withoutSnapshot)).toThrowError(
      ProviderDriverConfigurationError,
    );
    expect(fixture.codexStart).not.toHaveBeenCalled();
  });

  it("refuses a replayed secondary Codex account that still lacks its own home", () => {
    const fixture = factoryFixture();
    const owner = provider("codex");
    const secondary = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000062",
      displayName: "Codex secondary",
      driverKind: "codex",
      configuration: {
        kind: "codex-cli",
        binaryPath: "/missing/codex",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-16T11:00:00.000Z",
      updatedAt: "2026-07-16T11:00:00.000Z",
    });

    expect(() =>
      makeProviderDriver(secondary, { ...fixture.options, codexInstances: [owner, secondary] }),
    ).toThrow(/own home directory/);
    expect(fixture.codexStart).not.toHaveBeenCalled();
  });

  it("starts each Codex account as its own app-server with an isolated home", async () => {
    const fixture = factoryFixture();
    const extraId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000062");
    const extraHome = "/Users/test/.codex-accounts/80000000-0000-4000-8000-000000000062";
    const owner = provider("codex");
    const extra = decodeProviderInstance({
      id: extraId,
      displayName: "Codex work",
      driverKind: "codex",
      configuration: {
        kind: "codex-cli",
        binaryPath: "/missing/codex",
        codexHome: extraHome,
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-16T11:00:00.000Z",
      updatedAt: "2026-07-16T11:00:00.000Z",
    });
    const options = {
      ...fixture.options,
      codexInstances: [owner, extra],
      codexHostEnvironment: {
        PATH: "/usr/bin",
        CODEX_HOME: "/Users/test/.codex",
        OPENAI_API_KEY: "inherited-must-not-cross",
        CODEX_ACCESS_TOKEN: "inherited-must-not-cross",
        CODEX_API_KEY: "inherited-must-not-cross",
        AWS_BEARER_TOKEN_BEDROCK: "inherited-must-not-cross",
      },
    };

    await expect(runProbe(makeProviderDriver(owner, options))).rejects.toThrow(
      /Codex process selected/,
    );
    expect(fixture.codexStart).toHaveBeenCalledOnce();
    const ownerLaunch = fixture.codexStart.mock.calls[0]?.[0] as {
      readonly environment?: NodeJS.ProcessEnv;
    };
    expect(ownerLaunch.environment?.CODEX_HOME).toBe("/Users/test/.codex");
    expect(ownerLaunch.environment?.OPENAI_API_KEY).toBe("inherited-must-not-cross");
    expect(ownerLaunch.environment?.CODEX_ACCESS_TOKEN).toBe("inherited-must-not-cross");
    expect(ownerLaunch.environment?.CODEX_API_KEY).toBe("inherited-must-not-cross");
    expect(ownerLaunch.environment?.AWS_BEARER_TOKEN_BEDROCK).toBe("inherited-must-not-cross");

    fixture.codexStart.mockClear();
    await expect(
      Effect.runPromise(
        Effect.scoped(makeProviderDriver(extra, options).probe({ instanceId: extraId })),
      ),
    ).rejects.toThrow(/Codex process selected/);
    expect(fixture.codexStart).toHaveBeenCalledOnce();
    const extraLaunch = fixture.codexStart.mock.calls[0]?.[0] as {
      readonly environment?: NodeJS.ProcessEnv;
    };
    expect(extraLaunch.environment?.CODEX_HOME).toBe(extraHome);
    expect(extraLaunch.environment?.OPENAI_API_KEY).toBeUndefined();
    expect(extraLaunch.environment?.CODEX_HOME).not.toBe(ownerLaunch.environment?.CODEX_HOME);
  });

  it("injects only a broker-resolved Codex API key into that account's app-server", async () => {
    const fixture = factoryFixture();
    const owner = provider("codex");
    await expect(
      runProbe(
        makeProviderDriver(owner, {
          ...fixture.options,
          codexInstances: [owner],
          codexHostEnvironment: {
            PATH: "/usr/bin",
            OPENAI_API_KEY: "inherited-must-not-cross",
          },
          credentialResolver: {
            has: async () => true,
            resolve: async () => "broker-resolved-key",
          },
        }),
      ),
    ).rejects.toThrow(/Codex process selected/);
    const launch = fixture.codexStart.mock.calls[0]?.[0] as {
      readonly environment?: NodeJS.ProcessEnv;
    };
    expect(launch.environment?.OPENAI_API_KEY).toBe("broker-resolved-key");
    expect(launch.environment?.CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it("selects the injected Claude ports only for a Claude instance", async () => {
    const fixture = factoryFixture();
    const driver = makeProviderDriver(provider("claude"), fixture.options);

    await expect(runProbe(driver)).rejects.toThrow(/Claude process selected/);
    expect(fixture.claudeProbeVersion).toHaveBeenCalledOnce();
    expect(fixture.codexStart).not.toHaveBeenCalled();
    expect(fixture.openCodeStart).not.toHaveBeenCalled();
  });

  it("refuses to construct a Claude driver without the account snapshot", () => {
    const fixture = factoryFixture();
    const { claudeInstances: _ignored, ...withoutSnapshot } = fixture.options;

    expect(() => makeProviderDriver(provider("claude"), withoutSnapshot)).toThrowError(
      ProviderDriverConfigurationError,
    );
    expect(fixture.claudeProbeVersion).not.toHaveBeenCalled();
  });

  it("refuses a replayed secondary Claude account that still lacks its own directory", () => {
    const fixture = factoryFixture();
    const owner = provider("claude");
    const secondary = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000062",
      displayName: "Claude secondary",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/missing/claude",
        authentication: "subscription",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-16T11:00:00.000Z",
      updatedAt: "2026-07-16T11:00:00.000Z",
    });

    expect(() =>
      makeProviderDriver(secondary, { ...fixture.options, claudeInstances: [owner, secondary] }),
    ).toThrow(/own config directory/);
    expect(fixture.claudeProbeVersion).not.toHaveBeenCalled();
  });

  it("refuses the implicit Claude account when the host overlay is a relative directory", () => {
    const fixture = factoryFixture();
    const owner = provider("claude");
    expect(() =>
      makeProviderDriver(owner, {
        ...fixture.options,
        claudeInstances: [owner],
        claudeHostEnvironment: { CLAUDE_CONFIG_DIR: "relative-claude" },
      }),
    ).toThrow(/must be absolute/);
    expect(fixture.claudeProbeVersion).not.toHaveBeenCalled();
  });

  it("builds an isolated Claude driver when the host overlay is relative", () => {
    const fixture = factoryFixture();
    const isolated = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000063",
      displayName: "Claude isolated",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/missing/claude",
        authentication: "subscription",
        configDirectory: "/tmp/octant-claude-isolated",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-16T11:00:00.000Z",
      updatedAt: "2026-07-16T11:00:00.000Z",
    });

    expect(() =>
      makeProviderDriver(isolated, {
        ...fixture.options,
        claudeInstances: [isolated],
        claudeHostEnvironment: { CLAUDE_CONFIG_DIR: "relative-claude" },
      }),
    ).not.toThrow();
  });

  it("builds a directory-less API-key Claude driver when the host overlay is relative", () => {
    const fixture = factoryFixture();
    const apiKey = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000064",
      displayName: "Claude API key",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/missing/claude",
        authentication: "api-key",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-16T11:00:00.000Z",
      updatedAt: "2026-07-16T11:00:00.000Z",
    });

    expect(() =>
      makeProviderDriver(apiKey, {
        ...fixture.options,
        claudeInstances: [apiKey],
        claudeHostEnvironment: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "relative-secure" },
      }),
    ).not.toThrow();
  });

  it("refuses a Claude driver whose host overlay now matches another account directory", () => {
    const fixture = factoryFixture();
    const owner = provider("claude");
    const directory = "/tmp/octant-claude-peer-dir";
    const secondary = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000062",
      displayName: "Claude secondary",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/missing/claude",
        authentication: "subscription",
        configDirectory: directory,
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-16T11:00:00.000Z",
      updatedAt: "2026-07-16T11:00:00.000Z",
    });
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = directory;
    try {
      expect(() =>
        makeProviderDriver(owner, {
          ...fixture.options,
          claudeInstances: [owner, secondary],
          claudeHostEnvironment: { ...process.env },
        }),
      ).toThrow(/already uses that config directory/);
      expect(fixture.claudeProbeVersion).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
  });

  it("does not treat a resume overlay as the host Claude directory", async () => {
    const fixture = factoryFixture();
    const owner = provider("claude");
    const directory = "/tmp/octant-claude-overlay-dir";
    const secondary = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000062",
      displayName: "Claude secondary",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/missing/claude",
        authentication: "subscription",
        configDirectory: directory,
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-16T11:00:00.000Z",
      updatedAt: "2026-07-16T11:00:00.000Z",
    });
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const previousSecure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    await snapshotClaudeHostEnvironment();
    process.env.CLAUDE_CONFIG_DIR = directory;
    try {
      expect(() =>
        makeProviderDriver(owner, { ...fixture.options, claudeInstances: [owner, secondary] }),
      ).not.toThrow();
    } finally {
      if (previousConfig === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfig;
      }
      if (previousSecure === undefined) {
        delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = previousSecure;
      }
    }
  });

  it.each([
    ["kimi-code", "/missing/kimi"],
    ["mistral-vibe", "/missing/vibe-acp"],
    ["devin", "/missing/devin"],
    ["kilo", "/missing/kilo"],
  ] as const)(
    "selects the shared ACP process and per-kind managed home for %s",
    async (driverKind, binaryPath) => {
      const fixture = factoryFixture();
      const driver = makeProviderDriver(provider(driverKind), fixture.options);

      await expect(runProbe(driver)).rejects.toThrow(/ACP process selected/);
      expect(fixture.acpStart).toHaveBeenCalledWith({
        profile: expect.objectContaining({ kind: driverKind }),
        binaryPath,
        root: `/managed/${driverKind}/${instanceId}`,
        managedHome: `/managed/${driverKind}/${instanceId}`,
        mode: "chat",
        executionPolicy: "approval-gated",
        purpose: "probe",
        onProcessStarted: expect.any(Function),
      });
      expect(fixture.codexStart).not.toHaveBeenCalled();
      expect(fixture.openCodeStart).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["glm", "glm-acp", "/missing/glm"],
    ["gemini", "gemini-acp", "/missing/gemini"],
    ["cline", "cline-acp", "/missing/cline"],
    ["qwen", "qwen-acp", "/missing/qwen"],
  ] as const)(
    "reaches the ACP process for a provider-owned %s instance without consulting the credential broker",
    async (driverKind, configurationKind, binaryPath) => {
      const fixture = factoryFixture();
      const credentialResolver = {
        has: vi.fn(async () => true),
        resolve: vi.fn(async () => "secret-provider-key"),
      };
      const driver = makeProviderDriver(
        dualAuthCliInstance(driverKind, configurationKind, binaryPath, "provider-owned"),
        { ...fixture.options, credentialResolver },
      );

      await expect(runProbe(driver)).rejects.toThrow(/ACP process selected/);
      expect(credentialResolver.has).not.toHaveBeenCalled();
      expect(credentialResolver.resolve).not.toHaveBeenCalled();
      expect(fixture.acpStart).toHaveBeenCalledWith({
        profile: expect.objectContaining({ kind: driverKind }),
        binaryPath,
        root: `/managed/${driverKind}/${instanceId}`,
        managedHome: `/managed/${driverKind}/${instanceId}`,
        mode: "chat",
        executionPolicy: "approval-gated",
        purpose: "probe",
        onProcessStarted: expect.any(Function),
      });
      expect(fixture.acpStart.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
    },
  );

  it.each([
    ["glm", "glm-acp", "/missing/glm"],
    ["gemini", "gemini-acp", "/missing/gemini"],
    ["cline", "cline-acp", "/missing/cline"],
    ["qwen", "qwen-acp", "/missing/qwen"],
  ] as const)(
    "resolves a broker API key only for an explicit %s api-key instance",
    async (driverKind, configurationKind, binaryPath) => {
      const fixture = factoryFixture();
      const credentialResolver = {
        has: vi.fn(async () => true),
        resolve: vi.fn(async () => "secret-provider-key"),
      };
      const driver = makeProviderDriver(
        dualAuthCliInstance(driverKind, configurationKind, binaryPath, "api-key"),
        { ...fixture.options, credentialResolver },
      );

      await expect(runProbe(driver)).rejects.toThrow(/ACP process selected/);
      expect(credentialResolver.has).toHaveBeenCalledWith(instanceId);
      expect(credentialResolver.resolve).toHaveBeenCalledWith(instanceId);
      expect(fixture.acpStart).toHaveBeenCalledWith(
        expect.objectContaining({
          binaryPath,
          apiKey: "secret-provider-key",
        }),
      );
    },
  );

  it("selects the Pi process and managed home only for a Pi instance", async () => {
    const fixture = factoryFixture();
    const driver = makeProviderDriver(provider("pi"), fixture.options);

    await expect(runProbe(driver)).rejects.toThrow(/Pi process selected/);
    expect(fixture.piStart).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: "/missing/pi",
        root: `/managed/pi/${instanceId}`,
        piHome: `/managed/pi/${instanceId}`,
        mode: "chat",
        executionPolicy: "approval-gated",
        onProcessStarted: expect.any(Function),
      }),
    );
    expect(fixture.codexStart).not.toHaveBeenCalled();
    expect(fixture.openCodeStart).not.toHaveBeenCalled();
  });

  it("selects the native Ollama HTTP driver only for an Ollama instance", async () => {
    const fixture = factoryFixture();
    const driver = makeProviderDriver(provider("ollama"), fixture.options);

    await expect(runProbe(driver)).rejects.toThrow(/Ollama endpoint selected/);
    expect(fixture.ollamaFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/version",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(fixture.piStart).not.toHaveBeenCalled();
  });

  it.each(["openai-image", "gemini-native-image", "bfl-image", "ideogram-image"] as const)(
    "refuses to construct a chat driver for an %s image profile",
    (driverKind) => {
      const fixture = factoryFixture();
      const displayName =
        driverKind === "openai-image"
          ? "GPT Image"
          : driverKind === "gemini-native-image"
            ? "Gemini Image"
            : driverKind === "bfl-image"
              ? "FLUX"
              : "Ideogram";
      const configuration =
        driverKind === "openai-image"
          ? {
              kind: "openai-image-http" as const,
              modelAllowlist: ["gpt-image-2"],
              defaultModel: "gpt-image-2",
            }
          : driverKind === "gemini-native-image"
            ? {
                kind: "gemini-native-image-http" as const,
                modelAllowlist: ["gemini-3.1-flash-image"],
                defaultModel: "gemini-3.1-flash-image",
              }
            : driverKind === "bfl-image"
              ? {
                  kind: "bfl-image-http" as const,
                  modelAllowlist: ["flux-pro-1.1"],
                  defaultModel: "flux-pro-1.1",
                }
              : {
                  kind: "ideogram-image-http" as const,
                  modelAllowlist: ["ideogram-v3"],
                  defaultModel: "ideogram-v3",
                };
      const instance = decodeProviderInstance({
        id: instanceId,
        displayName,
        driverKind,
        configuration,
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      expect(() => makeProviderDriver(instance, fixture.options)).toThrowError(
        ProviderDriverConfigurationError,
      );
      expect(fixture.openCodeStart).not.toHaveBeenCalled();
      expect(fixture.codexStart).not.toHaveBeenCalled();
    },
  );

  it.each(["opencode", "codex", "claude", "pi", "kilo", "devin", "ollama"] as const)(
    "agrees with the shared rule on whether %s keeps the conversation itself",
    (kind) => {
      // The renderer's picker reads providerKeepsConversation to know which
      // switches a started Chat or Work thread can take; it must say what the
      // driver the host actually builds says.
      const driver = makeProviderDriver(provider(kind), factoryFixture().options);
      expect(driver.conversationOwnership === "provider").toBe(providerKeepsConversation(kind));
    },
  );

  it("fails closed for an impossible provider kind", () => {
    const fixture = factoryFixture();
    const impossible = {
      ...provider("opencode"),
      driverKind: "unknown",
    } as unknown as ProviderInstance;

    expect(() => makeProviderDriver(impossible, fixture.options)).toThrowError(
      ProviderDriverConfigurationError,
    );
    try {
      makeProviderDriver(impossible, fixture.options);
    } catch (error) {
      expect(error).toMatchObject({
        failure: {
          category: "invalid-configuration",
          message: "Provider driver configuration is invalid.",
        },
      });
    }
    expect(fixture.openCodeStart).not.toHaveBeenCalled();
    expect(fixture.codexStart).not.toHaveBeenCalled();
  });
});

function factoryFixture(): {
  readonly options: ProviderDriverFactoryOptions;
  readonly openCodeStart: ReturnType<typeof vi.fn>;
  readonly codexStart: ReturnType<typeof vi.fn>;
  readonly claudeProbeVersion: ReturnType<typeof vi.fn>;
  readonly acpStart: ReturnType<typeof vi.fn>;
  readonly piStart: ReturnType<typeof vi.fn>;
  readonly ollamaFetch: ReturnType<typeof vi.fn>;
} {
  const openCodeStart = vi.fn(() =>
    Effect.fail({ category: "unavailable" as const, message: "OpenCode process selected." }),
  );
  const codexStart = vi.fn(() =>
    Effect.fail({ category: "unavailable" as const, message: "Codex process selected." }),
  );
  const claudeProbeVersion = vi.fn(() =>
    Effect.fail({ category: "unavailable" as const, message: "Claude process selected." }),
  );
  const acpStart = vi.fn(() =>
    Effect.fail({ category: "unavailable" as const, message: "ACP process selected." }),
  );
  const piStart = vi.fn(() =>
    Effect.fail({ category: "unavailable" as const, message: "Pi process selected." }),
  );
  const ollamaFetch = vi.fn<OllamaFetch>(async () => {
    throw { category: "unavailable", message: "Ollama endpoint selected." };
  });
  const options = {
    runtimeRegistry: new ProviderRuntimeRegistry(),
    openCodeProcess: { start: openCodeStart } as OpenCodeProcessPort,
    codexProcess: { start: codexStart } as CodexProcessPort,
    claudeProcess: {
      probeVersion: claudeProbeVersion,
    } as unknown as ClaudeProcessPort,
    acpProcess: { start: acpStart } as unknown as AcpProcessPort,
    acpHome: (kind: string, id: typeof instanceId) => `/managed/${kind}/${id}`,
    piProcess: { start: piStart } as unknown as PiProcessPort,
    piHome: (id: typeof instanceId) => `/managed/pi/${id}`,
    ollamaFetch,
    claudeSdk: {} as ClaudeAgentSdkPort,
    claudeResumeIdentityPort: {
      lookup: async () => undefined,
      put: async () => undefined,
      remove: async () => undefined,
    },
    isProjectConfinedPath: (root: string, path: string) => path.startsWith(`${root}/`),
    permissionPersistence: () => "current-session" as const,
    claudeInstances: [provider("claude")],
    codexInstances: [provider("codex")],
  } as unknown as ProviderDriverFactoryOptions;
  return {
    openCodeStart,
    codexStart,
    claudeProbeVersion,
    acpStart,
    piStart,
    ollamaFetch,
    options,
  };
}

function provider(
  driverKind:
    | "opencode"
    | "codex"
    | "claude"
    | "kimi-code"
    | "mistral-vibe"
    | "devin"
    | "kilo"
    | "pi"
    | "ollama",
  binaryPath = `/missing/${driverKind}`,
): ProviderInstance {
  return decodeProviderInstance({
    id: instanceId,
    displayName:
      driverKind === "opencode"
        ? "OpenCode local"
        : driverKind === "codex"
          ? "Codex local"
          : driverKind === "claude"
            ? "Claude local"
            : driverKind === "kimi-code"
              ? "Kimi local"
              : driverKind === "mistral-vibe"
                ? "Mistral Vibe local"
                : driverKind === "devin"
                  ? "Devin local"
                  : driverKind === "kilo"
                    ? "Kilo local"
                    : driverKind === "pi"
                      ? "Pi local"
                      : "Ollama local",
    driverKind,
    configuration:
      driverKind === "opencode"
        ? { kind: "opencode-cli", binaryPath }
        : driverKind === "codex"
          ? { kind: "codex-cli", binaryPath: "/missing/codex" }
          : driverKind === "claude"
            ? {
                kind: "claude-agent-sdk",
                binaryPath: "/missing/claude",
                authentication: "subscription",
              }
            : driverKind === "kimi-code"
              ? { kind: "kimi-code-acp", binaryPath: "/missing/kimi" }
              : driverKind === "mistral-vibe"
                ? {
                    kind: "mistral-vibe-acp",
                    binaryPath: "/missing/vibe-acp",
                    authentication: "subscription",
                  }
                : driverKind === "devin"
                  ? {
                      kind: "devin-acp",
                      binaryPath: "/missing/devin",
                      authentication: "subscription",
                    }
                  : driverKind === "kilo"
                    ? { kind: "kilo-acp", binaryPath: "/missing/kilo" }
                    : driverKind === "pi"
                      ? { kind: "pi-rpc", binaryPath: "/missing/pi" }
                      : {
                          kind: "ollama-native-http",
                          baseUrl: "http://127.0.0.1:11434",
                        },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function dualAuthCliInstance(
  driverKind: "glm" | "gemini" | "cline" | "qwen",
  configurationKind: "glm-acp" | "gemini-acp" | "cline-acp" | "qwen-acp",
  binaryPath: string,
  authentication: "provider-owned" | "api-key",
): ProviderInstance {
  return decodeProviderInstance({
    id: instanceId,
    displayName: `${driverKind} local`,
    driverKind,
    configuration: { kind: configurationKind, binaryPath, authentication },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function runProbe(driver: ReturnType<typeof makeProviderDriver>): Promise<unknown> {
  return Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
}
