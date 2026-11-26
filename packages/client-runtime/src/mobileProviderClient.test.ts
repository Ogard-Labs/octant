import { describe, expect, it, vi } from "vitest";
import {
  decodeHostAnswer,
  decodeProviderInstance,
  decodeProviderModelId,
  decodeProviderRegistrySnapshot,
  ProviderRegistrySnapshot,
  type ProviderInstanceId,
} from "@octant/contracts";
import {
  decodeMobileModelOptionId,
  encodeMobileModelOptionId,
  fetchMobileModelOptions,
  keepDeclaredModelOptionValues,
  normalizeMobileModelOptions,
  normalizeMobileProviderDirectory,
} from "./mobileProviderClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const now = "2026-08-05T20:00:00.000Z";
const instanceA = "00000000-0000-4000-8000-000000000301" as ProviderInstanceId;
const instanceB = "00000000-0000-4000-8000-000000000302" as ProviderInstanceId;

const capabilities = {
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
  harnessAutoReview: "unsupported",
  nativeAttachments: "supported",
  nativeWebResearch: "unsupported",
  appManagedTools: "supported",
  citations: "supported",
} as const;

const effortOption = {
  id: "effort",
  displayName: "Reasoning effort",
  kind: "selection" as const,
  values: ["low", "high"] as [string, ...string[]],
};
const fastOption = {
  id: "fast",
  displayName: "Fast mode",
  kind: "boolean" as const,
};

function model(
  id: string,
  displayName: string,
  options: ReadonlyArray<typeof effortOption | typeof fastOption> = [],
) {
  return {
    id: decodeProviderModelId(id),
    displayName,
    source: "discovered" as const,
    verification: "verified" as const,
    reasoning: "supported" as const,
    inputModalities: ["text" as const],
    options,
  };
}

function snapshot() {
  return decodeProviderRegistrySnapshot({
    instances: [
      decodeProviderInstance({
        id: instanceA,
        displayName: "Alpha",
        driverKind: "openai-compatible",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://alpha.example/v1/",
          authentication: "none",
          protocol: "responses",
          manualModelIds: [],
        },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
      decodeProviderInstance({
        id: instanceB,
        displayName: "Bravo",
        driverKind: "openai-compatible",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://bravo.example/v1/",
          authentication: "none",
          protocol: "responses",
          manualModelIds: [],
        },
        enabled: false,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    defaults: { permissionPersistence: "current-session", version: 0 },
    observedStates: [
      {
        instanceId: instanceA,
        readiness: "ready",
        processState: "running",
        models: [
          model("model-a", "Model A"),
          model("model-b", "Model B", [effortOption, fastOption]),
        ],
        capabilities,
        observedAt: now,
      },
      {
        instanceId: instanceB,
        readiness: "ready",
        processState: "running",
        models: [model("model-x", "Hidden")],
        capabilities,
        observedAt: now,
      },
    ],
  });
}

describe("mobile provider catalog", () => {
  it("encodes and decodes composite model option ids", () => {
    const id = encodeMobileModelOptionId(String(instanceA), "model-a");
    expect(decodeMobileModelOptionId(id)).toEqual({
      providerInstanceId: String(instanceA),
      modelId: "model-a",
    });
    expect(decodeMobileModelOptionId("bad")).toBeUndefined();
  });

  it("lists only enabled ready/degraded models without secrets", () => {
    const options = normalizeMobileModelOptions(snapshot());
    expect(options).toEqual([
      {
        id: encodeMobileModelOptionId(String(instanceA), "model-a"),
        providerInstanceId: String(instanceA),
        modelId: "model-a",
        label: "Model A",
        detail: "Alpha",
        driverKind: "openai-compatible",
        attachmentModalities: ["text"],
      },
      {
        id: encodeMobileModelOptionId(String(instanceA), "model-b"),
        providerInstanceId: String(instanceA),
        modelId: "model-b",
        label: "Model B",
        detail: "Alpha",
        driverKind: "openai-compatible",
        attachmentModalities: ["text"],
        settings: [effortOption, fastOption],
      },
    ]);
    expect(JSON.stringify(options)).not.toContain("baseUrl");
    expect(JSON.stringify(options)).not.toContain("authentication");
  });

  it("carries the account's own slash commands on each of its models, and none when it lists none", () => {
    const commands = [
      { name: "review", description: "Review the change", argumentHint: "<scope>" },
    ];
    const base = snapshot();
    const withCommands = ProviderRegistrySnapshot.make({
      ...base,
      observedStates: base.observedStates.map((observed) =>
        observed.instanceId === instanceA ? { ...observed, commands } : observed,
      ),
    });
    expect(normalizeMobileModelOptions(withCommands).map((option) => option.commands)).toEqual([
      commands,
      commands,
    ]);
    const empty = ProviderRegistrySnapshot.make({
      ...base,
      observedStates: base.observedStates.map((observed) => ({ ...observed, commands: [] })),
    });
    expect(normalizeMobileModelOptions(empty).every((option) => !("commands" in option))).toBe(
      true,
    );
  });

  it("keeps only the option values a model declares", () => {
    const settings = [effortOption, fastOption];
    expect(
      keepDeclaredModelOptionValues(settings, {
        effort: "high",
        fast: "true",
        speed: "high",
      }),
    ).toEqual({ effort: "high" });
    expect(keepDeclaredModelOptionValues(settings, { effort: "extreme" })).toEqual({});
    expect(keepDeclaredModelOptionValues(undefined, { effort: "high" })).toEqual({});
    expect(keepDeclaredModelOptionValues(settings, undefined)).toEqual({});
  });

  it("retains disabled and unready accounts in the display directory for historical handoffs", () => {
    const directory = normalizeMobileProviderDirectory(snapshot());
    expect(directory).toEqual([
      {
        providerInstanceId: String(instanceA),
        displayName: "Alpha",
        driverKind: "openai-compatible",
        models: [
          { modelId: "model-a", displayName: "Model A" },
          { modelId: "model-b", displayName: "Model B" },
        ],
      },
      {
        providerInstanceId: String(instanceB),
        displayName: "Bravo",
        driverKind: "openai-compatible",
        models: [{ modelId: "model-x", displayName: "Hidden" }],
      },
    ]);
  });

  it("falls back to persisted catalog model names when a probe clears an account's observed models", () => {
    const probed = decodeProviderRegistrySnapshot({
      ...snapshot(),
      observedStates: [
        {
          instanceId: instanceA,
          readiness: "ready",
          processState: "running",
          models: [model("model-a", "Model A Live")],
          capabilities,
          observedAt: now,
        },
        {
          instanceId: instanceB,
          readiness: "unavailable",
          processState: "stopped",
          models: [],
          capabilities,
          observedAt: now,
        },
      ],
      catalogs: [
        {
          instanceId: instanceA,
          version: 1,
          models: [model("model-a", "Model A Persisted"), model("model-b", "Model B Persisted")],
          manualModelOrder: [],
          invalidated: false,
          updatedAt: now,
        },
        {
          instanceId: instanceB,
          version: 1,
          models: [model("model-x", "Historical Model X")],
          manualModelOrder: [],
          invalidated: false,
          updatedAt: now,
        },
      ],
    });

    const directory = normalizeMobileProviderDirectory(probed);
    expect(directory).toEqual([
      {
        providerInstanceId: String(instanceA),
        displayName: "Alpha",
        driverKind: "openai-compatible",
        models: [
          { modelId: "model-a", displayName: "Model A Live" },
          { modelId: "model-b", displayName: "Model B Persisted" },
        ],
      },
      {
        providerInstanceId: String(instanceB),
        displayName: "Bravo",
        driverKind: "openai-compatible",
        models: [{ modelId: "model-x", displayName: "Historical Model X" }],
      },
    ]);
  });

  it("skips unavailable readiness and fetches via bootstrap", async () => {
    const unavailable = decodeProviderRegistrySnapshot({
      ...snapshot(),
      observedStates: [
        {
          instanceId: instanceA,
          readiness: "unavailable",
          processState: "stopped",
          models: [model("model-a", "Model A")],
          capabilities,
          observedAt: now,
        },
      ],
    });
    expect(normalizeMobileModelOptions(unavailable)).toEqual([]);

    const transport: MobileRemoteTransport = {
      hostId: "host-1",
      authenticatedFetch: vi.fn(async () => Response.json(snapshot())),
    };
    const options = await fetchMobileModelOptions(transport);
    expect(options).toHaveLength(2);
    expect(transport.authenticatedFetch).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/providers/bootstrap",
    });
  });

  it("an older phone still reads a catalog whose refused provider carries a sign-in detail it doesn't know", () => {
    const catalog = decodeHostAnswer(ProviderRegistrySnapshot)({
      instances: [
        decodeProviderInstance({
          id: instanceA,
          displayName: "Alpha",
          driverKind: "openai-compatible",
          configuration: {
            kind: "openai-compatible-http",
            baseUrl: "https://alpha.example/v1/",
            authentication: "none",
            protocol: "responses",
            manualModelIds: [],
          },
          enabled: true,
          environmentPolicy: "inherit-host",
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
        decodeProviderInstance({
          id: instanceB,
          displayName: "Bravo",
          driverKind: "openai-compatible",
          configuration: {
            kind: "openai-compatible-http",
            baseUrl: "https://bravo.example/v1/",
            authentication: "none",
            protocol: "responses",
            manualModelIds: [],
          },
          enabled: true,
          environmentPolicy: "inherit-host",
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ],
      defaults: { permissionPersistence: "current-session", version: 0 },
      observedStates: [
        {
          instanceId: instanceA,
          readiness: "ready",
          processState: "running",
          models: [model("model-a", "Model A")],
          capabilities,
          observedAt: now,
        },
        {
          instanceId: instanceB,
          readiness: "unauthenticated",
          processState: "stopped",
          models: [],
          capabilities,
          message: "Provider authentication is required.",
          reason: "authentication-required",
          // The sign-in detail this build knows, and a detail a newer host
          // could add later: an older phone drops both and keeps the catalog.
          signInNotOffered: true,
          signInNextDetail: "cli-update",
          observedAt: now,
        },
      ],
    });

    expect(catalog.observedStates.find((o) => o.instanceId === instanceB)?.reason).toBe(
      "authentication-required",
    );
    expect(normalizeMobileModelOptions(catalog)).toEqual([
      {
        id: encodeMobileModelOptionId(String(instanceA), "model-a"),
        providerInstanceId: String(instanceA),
        modelId: "model-a",
        label: "Model A",
        detail: "Alpha",
        driverKind: "openai-compatible",
        attachmentModalities: ["text"],
      },
    ]);
  });
});
