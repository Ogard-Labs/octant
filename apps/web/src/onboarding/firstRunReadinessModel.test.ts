import type {
  DiscoverySnapshot,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  describeDiscoveryNotice,
  summarizeFirstRunReadiness,
  type FirstRunReadinessInput,
} from "./firstRunReadinessModel";

const instanceId = (value: string) => value as ProviderInstanceId;

function instance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: instanceId("11111111-1111-4111-8111-111111111111"),
    displayName: "Ollama",
    driverKind: "ollama",
    enabled: true,
    ...overrides,
  } as ProviderInstance;
}

function observed(overrides: Partial<ProviderObservedState> = {}): ProviderObservedState {
  return {
    instanceId: instanceId("11111111-1111-4111-8111-111111111111"),
    readiness: "ready",
    processState: "running",
    models: [{ id: "llama", displayName: "Llama" }],
    capabilities: {},
    observedAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  } as unknown as ProviderObservedState;
}

function summarize(overrides: Partial<FirstRunReadinessInput> = {}) {
  return summarizeFirstRunReadiness({
    providerStatus: "ready",
    instances: [],
    observedByInstance: new Map(),
    ...overrides,
  });
}

describe("first-run provider readiness", () => {
  it("never reports an unprobed or disabled provider as ready", () => {
    const disabled = instance({
      id: instanceId("22222222-2222-4222-8222-222222222222"),
      displayName: "Codex",
      driverKind: "codex",
      enabled: false,
    });

    const summary = summarize({ instances: [instance(), disabled] });

    expect(summary.readyCount).toBe(0);
    expect(summary.overall).toBe("action-required");
    expect(summary.providers.map((provider) => [provider.state, provider.label])).toEqual([
      ["unverified", "Not checked"],
      ["disabled", "Disabled"],
    ]);
  });

  it("reports a probed provider as ready only when the host also observed models", () => {
    const withModels = summarize({
      instances: [instance()],
      observedByInstance: new Map([[instance().id, observed()]]),
    });
    const withoutModels = summarize({
      instances: [instance()],
      observedByInstance: new Map([[instance().id, observed({ models: [] })]]),
    });

    expect(withModels.overall).toBe("ready");
    expect(withModels.headline).toBe("1 provider is ready");
    expect(withoutModels.readyCount).toBe(0);
    expect(withoutModels.providers[0]?.label).toBe("No models");
  });

  it("reports a degraded provider that still offers its models as usable, without hiding the warning", () => {
    const degraded = summarize({
      instances: [instance()],
      observedByInstance: new Map([[instance().id, observed({ readiness: "degraded" })]]),
    });
    const degradedWithoutModels = summarize({
      instances: [instance()],
      observedByInstance: new Map([
        [instance().id, observed({ readiness: "degraded", models: [] })],
      ]),
    });

    expect(degraded.overall).toBe("ready");
    expect(degraded.usableCount).toBe(1);
    expect(degraded.readyCount).toBe(0);
    expect(degraded.providers[0]?.state).toBe("degraded");
    expect(degraded.providers[0]?.label).toBe("Degraded");
    expect(degradedWithoutModels.overall).toBe("action-required");
    expect(degradedWithoutModels.usableCount).toBe(0);
  });

  it("separates an unreadable credential from an ordinary sign-in prompt", () => {
    const unreadable = summarize({
      instances: [instance()],
      observedByInstance: new Map([
        [instance().id, observed({ readiness: "ready", credentialStatus: "unavailable" })],
      ]),
    });
    const signIn = summarize({
      instances: [instance()],
      observedByInstance: new Map([
        [instance().id, observed({ readiness: "unauthenticated", credentialStatus: "missing" })],
      ]),
    });

    expect(unreadable.providers[0]?.state).toBe("credential-unavailable");
    expect(unreadable.readyCount).toBe(0);
    expect(signIn.providers[0]?.state).toBe("authentication-required");
  });

  it("says the registry is unreachable instead of claiming nothing is configured", () => {
    const unavailable = summarize({ providerStatus: "disconnected" });
    const empty = summarize({ providerStatus: "ready" });

    expect(unavailable.overall).toBe("authority-unavailable");
    expect(unavailable.detail).toContain("Nothing is assumed ready.");
    expect(empty.overall).toBe("none-configured");
  });

  it("counts detected runtimes that are not configured yet", () => {
    const snapshot = {
      hostId: "local",
      candidates: [
        { driverKind: "ollama", displayName: "Ollama", readiness: "ready" },
        { driverKind: "codex", displayName: "Codex", readiness: "unauthenticated" },
      ],
      scannedAt: "2026-08-15T10:00:00.000Z",
      scanDurationMs: 12,
      status: "completed",
    } as unknown as DiscoverySnapshot;

    const summary = summarize({ instances: [instance()], discoverySnapshot: snapshot });

    expect(summary.detectedCount).toBe(1);
  });
});

describe("first-run discovery notice", () => {
  it("names an incomplete scan and offers a retry rather than implying a full search", () => {
    const cancelled = describeDiscoveryNotice({
      scanning: false,
      snapshot: { status: "cancelled" } as DiscoverySnapshot,
    });

    expect(cancelled).toEqual({
      tone: "attention",
      message:
        "The scan for installed providers was cancelled. Some installed providers may be missing from this list.",
      retryable: true,
    });
    expect(
      describeDiscoveryNotice({ scanning: false, message: "Discovery scan failed." }),
    ).toMatchObject({ tone: "attention", retryable: true });
    expect(describeDiscoveryNotice({ scanning: true })).toMatchObject({ tone: "info" });
    expect(
      describeDiscoveryNotice({
        scanning: false,
        snapshot: { status: "completed" } as DiscoverySnapshot,
      }),
    ).toBeUndefined();
  });
});
