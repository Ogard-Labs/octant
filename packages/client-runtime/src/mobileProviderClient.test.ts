import { describe, expect, it, vi } from "vitest";
import {
  decodeProviderInstance,
  decodeProviderModelId,
  decodeProviderRegistrySnapshot,
  type ProviderInstanceId,
} from "@octant/contracts";
import {
  decodeMobileModelOptionId,
  encodeMobileModelOptionId,
  fetchMobileModelOptions,
  normalizeMobileModelOptions,
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
  nativeAttachments: "supported",
  nativeWebResearch: "unsupported",
  appManagedTools: "supported",
  citations: "supported",
} as const;

function model(id: string, displayName: string) {
  return {
    id: decodeProviderModelId(id),
    displayName,
    source: "discovered" as const,
    verification: "verified" as const,
    reasoning: "supported" as const,
    inputModalities: ["text" as const],
    options: [],
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
        models: [model("model-a", "Model A"), model("model-b", "Model B")],
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
      },
      {
        id: encodeMobileModelOptionId(String(instanceA), "model-b"),
        providerInstanceId: String(instanceA),
        modelId: "model-b",
        label: "Model B",
        detail: "Alpha",
      },
    ]);
    expect(JSON.stringify(options)).not.toContain("baseUrl");
    expect(JSON.stringify(options)).not.toContain("authentication");
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
});
