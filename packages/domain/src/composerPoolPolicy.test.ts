import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderModelId,
  ProviderObservedState,
  ProviderRegistrySnapshot,
} from "@octant/contracts/providers";
import type { HostId } from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";
import { buildComposerPoolModel, poolRejectionLabel } from "./composerPoolPolicy";

const hostId = "local" as HostId;
const openAiInstanceId = "80000000-0000-4000-8000-000000000010" as ProviderInstanceId;
const anthropicInstanceId = "80000000-0000-4000-8000-000000000020" as ProviderInstanceId;

function instance(patch: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: openAiInstanceId,
    displayName: "OpenAI gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1/",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  } as unknown as ProviderInstance;
}

function observation(patch: Partial<ProviderObservedState> = {}): ProviderObservedState {
  return {
    instanceId: openAiInstanceId,
    readiness: "ready",
    processState: "running",
    models: [
      { id: "gpt-5.2", displayName: "GPT 5.2" },
      { id: "gpt-5.2-mini", displayName: "GPT 5.2 Mini" },
    ],
    capabilities: {},
    observedAt: "2026-08-01T10:00:00.000Z",
    ...patch,
  } as unknown as ProviderObservedState;
}

function snapshot(patch: Partial<ProviderRegistrySnapshot> = {}): ProviderRegistrySnapshot {
  return {
    instances: [instance()],
    defaults: {
      permissionPersistence: "current-session",
      agentEligibleModels: [
        { providerInstanceId: openAiInstanceId, modelId: "gpt-5.2" as ProviderModelId },
        { providerInstanceId: openAiInstanceId, modelId: "gpt-5.2-mini" as ProviderModelId },
      ],
      version: 1,
    },
    observedStates: [observation()],
    ...patch,
  } as unknown as ProviderRegistrySnapshot;
}

const current = {
  providerInstanceId: openAiInstanceId,
  modelId: "gpt-5.2" as ProviderModelId,
};

describe("buildComposerPoolModel", () => {
  it("is loading while the provider registry snapshot has not arrived", () => {
    expect(buildComposerPoolModel({ snapshot: undefined, hostId, mode: "chat", current })).toEqual({
      kind: "loading",
    });
  });

  it("is unavailable when Settings define no agent-eligible default pool", () => {
    const model = buildComposerPoolModel({
      snapshot: snapshot({
        defaults: { permissionPersistence: "current-session", version: 1 },
      } as unknown as Partial<ProviderRegistrySnapshot>),
      hostId,
      mode: "chat",
      current,
    });
    expect(model.kind).toBe("unavailable");
    if (model.kind === "unavailable") {
      expect(model.reason).toMatch(/no agent-eligible models/i);
    }
  });

  it("is unavailable when Settings define fewer than two agent-eligible models", () => {
    const model = buildComposerPoolModel({
      snapshot: snapshot({
        defaults: {
          permissionPersistence: "current-session",
          agentEligibleModels: [
            { providerInstanceId: openAiInstanceId, modelId: "gpt-5.2" as ProviderModelId },
          ],
          version: 1,
        },
      } as unknown as Partial<ProviderRegistrySnapshot>),
      hostId,
      mode: "chat",
      current,
    });
    expect(model.kind).toBe("unavailable");
    if (model.kind === "unavailable") {
      expect(model.reason).toMatch(/at least two/i);
    }
  });

  it("marks ready models selectable with display names and flags the current route", () => {
    const model = buildComposerPoolModel({ snapshot: snapshot(), hostId, mode: "chat", current });
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    expect(model.candidates).toHaveLength(2);
    const [first, second] = model.candidates;
    expect(first).toMatchObject({
      providerName: "OpenAI gateway",
      modelName: "GPT 5.2",
      selectable: true,
      isCurrent: true,
      requiresMixedVendor: false,
    });
    expect(second).toMatchObject({
      modelName: "GPT 5.2 Mini",
      selectable: true,
      isCurrent: false,
      requiresMixedVendor: false,
    });
    expect(model.mixedVendorRequired).toBe(false);
  });

  it("fails closed per candidate: unconfigured, not-ready, and vanished models are not selectable", () => {
    const model = buildComposerPoolModel({
      snapshot: snapshot({
        instances: [instance()],
        defaults: {
          permissionPersistence: "current-session",
          agentEligibleModels: [
            { providerInstanceId: openAiInstanceId, modelId: "gpt-5.2" as ProviderModelId },
            { providerInstanceId: openAiInstanceId, modelId: "model-gone" as ProviderModelId },
            { providerInstanceId: anthropicInstanceId, modelId: "claude-x" as ProviderModelId },
          ],
          version: 1,
        },
      } as unknown as Partial<ProviderRegistrySnapshot>),
      hostId,
      mode: "chat",
      current,
    });
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    const [ok, gone, unconfigured] = model.candidates;
    expect(ok?.selectable).toBe(true);
    expect(gone?.selectable).toBe(false);
    expect(gone?.unavailableReason).toBe(poolRejectionLabel("model-unavailable"));
    expect(unconfigured?.selectable).toBe(false);
    expect(unconfigured?.unavailableReason).toBe(poolRejectionLabel("provider-unconfigured"));
  });

  it("treats a not-ready provider's models as unavailable", () => {
    const model = buildComposerPoolModel({
      snapshot: snapshot({ observedStates: [observation({ readiness: "unauthenticated" })] }),
      hostId,
      mode: "chat",
      current,
    });
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    expect(model.candidates.every((candidate) => !candidate.selectable)).toBe(true);
    expect(model.candidates[0]?.unavailableReason).toBe(poolRejectionLabel("provider-not-ready"));
  });

  it("flags candidates from another vendor as requiring the explicit mixed-vendor opt-in", () => {
    const anthropic = {
      ...instance(),
      id: anthropicInstanceId,
      displayName: "Anthropic gateway",
      driverKind: "anthropic-compatible",
    } as unknown as ProviderInstance;
    const model = buildComposerPoolModel({
      snapshot: snapshot({
        instances: [instance(), anthropic],
        defaults: {
          permissionPersistence: "current-session",
          agentEligibleModels: [
            { providerInstanceId: openAiInstanceId, modelId: "gpt-5.2" as ProviderModelId },
            { providerInstanceId: anthropicInstanceId, modelId: "claude-x" as ProviderModelId },
          ],
          version: 1,
        },
        observedStates: [
          observation(),
          observation({
            instanceId: anthropicInstanceId,
            models: [{ id: "claude-x", displayName: "Claude X" }],
          } as unknown as Partial<ProviderObservedState>),
        ],
      } as unknown as Partial<ProviderRegistrySnapshot>),
      hostId,
      mode: "chat",
      current,
    });
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    const [same, other] = model.candidates;
    expect(same?.requiresMixedVendor).toBe(false);
    expect(other?.requiresMixedVendor).toBe(true);
    expect(other?.selectable).toBe(true);
    expect(model.mixedVendorRequired).toBe(true);
  });
});
