import {
  decodeProviderInstance,
  decodeProviderModel,
  decodeProviderModelId,
  decodeProviderObservedState,
  decodeProviderRegistrySnapshot,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderRegistrySnapshot,
  type UtcTimestamp,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  createProviderModelRef,
  hostQualifiedRegistrySnapshot,
  listProviderModelRefs,
  providerModelRefEquals,
  type HostId,
  type ProviderModelRef,
} from "./providerFederation";

const now = "2026-07-21T10:00:00.000Z" as UtcTimestamp;
const hostA = "host-alpha" as HostId;
const hostB = "host-bravo" as HostId;
const instanceA = "00000000-0000-4000-8000-000000000301" as ProviderInstanceId;
const instanceB = "00000000-0000-4000-8000-000000000302" as ProviderInstanceId;
const modelId = decodeProviderModelId("shared-model");

function registry(): ProviderRegistrySnapshot {
  return decodeProviderRegistrySnapshot({
    instances: [
      decodeProviderInstance({
        id: instanceA,
        displayName: "Alpha gateway",
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
        displayName: "Bravo gateway",
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
    observedStates: [],
  });
}

function ref(host: HostId, instance: ProviderInstanceId, model: ProviderModelId): ProviderModelRef {
  return createProviderModelRef(host, instance, model);
}

describe("provider federation references", () => {
  it("qualifies a local registry snapshot with a hostId without mutating the source", () => {
    const snapshot = registry();
    const qualified = hostQualifiedRegistrySnapshot(snapshot, hostA);
    expect(qualified.hostId).toBe(hostA);
    expect(qualified.snapshot).toBe(snapshot);
    expect(snapshot.instances).toHaveLength(2);
  });

  it("builds a stable model reference from host, provider instance, and model ID", () => {
    const reference = ref(hostA, instanceA, modelId);
    expect(reference).toEqual({ hostId: hostA, providerInstanceId: instanceA, modelId });
  });

  it("treats model references as equal only when host, provider, and model all match", () => {
    expect(
      providerModelRefEquals(ref(hostA, instanceA, modelId), ref(hostA, instanceA, modelId)),
    ).toBe(true);
    expect(
      providerModelRefEquals(ref(hostA, instanceA, modelId), ref(hostB, instanceA, modelId)),
    ).toBe(false);
    expect(
      providerModelRefEquals(ref(hostA, instanceA, modelId), ref(hostA, instanceB, modelId)),
    ).toBe(false);
    expect(
      providerModelRefEquals(
        ref(hostA, instanceA, modelId),
        ref(hostA, instanceA, decodeProviderModelId("other-model")),
      ),
    ).toBe(false);
  });

  it("lists one host-qualified reference per provider model and distinguishes identical model IDs across providers", () => {
    const snapshot = decodeProviderRegistrySnapshot({
      ...registry(),
      catalogs: [
        {
          instanceId: instanceA,
          version: 1,
          models: [
            decodeProviderModel({
              id: "shared-model",
              displayName: "Shared on Alpha",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            }),
          ],
          manualModelOrder: [],
          invalidated: false,
          updatedAt: now,
        },
        {
          instanceId: instanceB,
          version: 1,
          models: [
            decodeProviderModel({
              id: "shared-model",
              displayName: "Shared on Bravo",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            }),
          ],
          manualModelOrder: [],
          invalidated: false,
          updatedAt: now,
        },
      ],
    });

    const refs = listProviderModelRefs(hostQualifiedRegistrySnapshot(snapshot, hostA));
    expect(refs).toHaveLength(2);
    expect(refs).toContainEqual(ref(hostA, instanceA, modelId));
    expect(refs).toContainEqual(ref(hostA, instanceB, modelId));
    expect(
      new Set(refs.map((value) => `${value.hostId}:${value.providerInstanceId}:${value.modelId}`))
        .size,
    ).toBe(2);
  });

  it("skips disabled provider instances when listing model references", () => {
    const snapshot = decodeProviderRegistrySnapshot({
      ...registry(),
      instances: registry().instances.map((instance, index) =>
        index === 0 ? { ...instance, enabled: false } : instance,
      ),
      catalogs: [
        {
          instanceId: instanceA,
          version: 1,
          models: [
            decodeProviderModel({
              id: "shared-model",
              displayName: "Shared on Alpha",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            }),
          ],
          manualModelOrder: [],
          invalidated: false,
          updatedAt: now,
        },
        {
          instanceId: instanceB,
          version: 1,
          models: [
            decodeProviderModel({
              id: "shared-model",
              displayName: "Shared on Bravo",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            }),
          ],
          manualModelOrder: [],
          invalidated: false,
          updatedAt: now,
        },
      ],
    });

    const refs = listProviderModelRefs(hostQualifiedRegistrySnapshot(snapshot, hostA));
    expect(refs).toEqual([ref(hostA, instanceB, modelId)]);
  });

  it("excludes invalidated catalogs so stale models are not selectable after a config change", () => {
    const snapshot = decodeProviderRegistrySnapshot({
      ...registry(),
      catalogs: [
        {
          instanceId: instanceA,
          version: 2,
          models: [
            decodeProviderModel({
              id: "shared-model",
              displayName: "Shared on Alpha",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            }),
          ],
          manualModelOrder: [],
          invalidated: true,
          invalidatedAt: now,
          invalidationReason: "provider configuration changed",
          updatedAt: now,
        },
        {
          instanceId: instanceB,
          version: 1,
          models: [
            decodeProviderModel({
              id: "shared-model",
              displayName: "Shared on Bravo",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            }),
          ],
          manualModelOrder: [],
          invalidated: false,
          updatedAt: now,
        },
      ],
    });

    const refs = listProviderModelRefs(hostQualifiedRegistrySnapshot(snapshot, hostA));
    expect(refs).toEqual([ref(hostA, instanceB, modelId)]);
  });

  it("suppresses model refs when the latest observed state is non-ready even with a valid catalog", () => {
    const snapshot = decodeProviderRegistrySnapshot({
      ...registry(),
      observedStates: [
        decodeProviderObservedState({
          instanceId: instanceA,
          readiness: "unauthenticated",
          processState: "stopped",
          models: [],
          capabilities: {
            streaming: "unavailable",
            resume: "unavailable",
            interruption: "unavailable",
            approvals: "unavailable",
            userQuestions: "unavailable",
            reasoning: "unavailable",
            usage: "unavailable",
            toolActivity: "unavailable",
            fileChanges: "unavailable",
            diffs: "unavailable",
            taskProgress: "unavailable",
            nativeChildAgents: "unavailable",
            nativeAttachments: "unavailable",
            nativeWebResearch: "unavailable",
            appManagedTools: "unavailable",
            citations: "unavailable",
          },
          observedAt: now,
        }),
      ],
      catalogs: [
        {
          instanceId: instanceA,
          version: 1,
          models: [
            decodeProviderModel({
              id: "shared-model",
              displayName: "Shared on Alpha",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            }),
          ],
          manualModelOrder: [],
          invalidated: false,
          updatedAt: now,
        },
        {
          instanceId: instanceB,
          version: 1,
          models: [
            decodeProviderModel({
              id: "shared-model",
              displayName: "Shared on Bravo",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            }),
          ],
          manualModelOrder: [],
          invalidated: false,
          updatedAt: now,
        },
      ],
    });

    const refs = listProviderModelRefs(hostQualifiedRegistrySnapshot(snapshot, hostA));
    expect(refs).toEqual([ref(hostA, instanceB, modelId)]);
  });
});
