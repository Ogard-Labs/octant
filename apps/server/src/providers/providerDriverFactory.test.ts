import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  type ProviderInstance,
} from "@octant/contracts";
import { BUNDLED_PROVIDER_DRIVER_PLUGINS } from "@octant/plugin-host/provider-drivers";
import { DISCOVERY_DESCRIPTORS } from "@octant/provider-sdk/discovery";
import { isAcpHostProfileDriver } from "@octant/provider-sdk/driver-plugins";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeAgentSdkPort } from "./claudeAgentSdkPort";
import type { ClaudeProcessPort } from "./claudeProcess";
import type { CodexProcessPort } from "./codexProcess";
import type { AcpProcessPort } from "./acpProcess";
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
    ]);
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

  it("selects the Codex process only for a Codex instance", async () => {
    const fixture = factoryFixture();
    const driver = makeProviderDriver(provider("codex"), fixture.options);

    await expect(runProbe(driver)).rejects.toThrow(/Codex process selected/);
    expect(fixture.codexStart).toHaveBeenCalledOnce();
    expect(fixture.openCodeStart).not.toHaveBeenCalled();
  });

  it("selects the injected Claude ports only for a Claude instance", async () => {
    const fixture = factoryFixture();
    const driver = makeProviderDriver(provider("claude"), fixture.options);

    await expect(runProbe(driver)).rejects.toThrow(/Claude process selected/);
    expect(fixture.claudeProbeVersion).toHaveBeenCalledOnce();
    expect(fixture.codexStart).not.toHaveBeenCalled();
    expect(fixture.openCodeStart).not.toHaveBeenCalled();
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
        onProcessStarted: expect.any(Function),
      });
      expect(fixture.codexStart).not.toHaveBeenCalled();
      expect(fixture.openCodeStart).not.toHaveBeenCalled();
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

  it.each(["openai-image", "gemini-native-image"] as const)(
    "refuses to construct a chat driver for an %s image profile",
    (driverKind) => {
      const fixture = factoryFixture();
      const instance = decodeProviderInstance({
        id: instanceId,
        displayName: driverKind === "openai-image" ? "GPT Image" : "Gemini Image",
        driverKind,
        configuration:
          driverKind === "openai-image"
            ? {
                kind: "openai-image-http",
                modelAllowlist: ["gpt-image-2"],
                defaultModel: "gpt-image-2",
              }
            : {
                kind: "gemini-native-image-http",
                modelAllowlist: ["gemini-3.1-flash-image"],
                defaultModel: "gemini-3.1-flash-image",
              },
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
        ? { kind: "opencode-cli", binaryPath: "/missing/opencode" }
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

function runProbe(driver: ReturnType<typeof makeProviderDriver>): Promise<unknown> {
  return Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
}
