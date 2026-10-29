import type {
  DiscoverySnapshot,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  describeDiscoveryNotice,
  describeFirstRunDiscoveryProgress,
  summarizeFirstRunReadiness,
  type FirstRunDiscoveryInput,
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

function searched(candidates: ReadonlyArray<unknown> = []): FirstRunDiscoveryInput {
  return {
    scanning: false,
    snapshot: {
      hostId: "local",
      candidates,
      scannedAt: "2026-08-15T10:00:00.000Z",
      scanDurationMs: 12,
      status: "completed",
    } as unknown as DiscoverySnapshot,
  };
}

// These run against a macOS host unless a test names another platform.
function summarize(overrides: Partial<FirstRunReadinessInput> = {}) {
  return summarizeFirstRunReadiness({
    providerStatus: "ready",
    instances: [],
    observedByInstance: new Map(),
    discovery: searched(),
    hostPlatform: "darwin",
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

  it("gives an Off provider the host's withheld reason instead of the plain turned-off line", () => {
    const reason = "fx is not offered yet: the current fx release cannot load certificates.";
    const fx = instance({ displayName: "fx", driverKind: "fx", enabled: false });

    const summary = summarize({
      instances: [fx],
      observedByInstance: new Map([
        [
          fx.id,
          observed({
            readiness: "unavailable",
            processState: "stopped",
            models: [],
            reason: "driver-not-admitted",
            message: reason,
          }),
        ],
      ]),
    });

    expect(summary.providers[0]).toMatchObject({ state: "disabled", detail: reason });
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

    expect(unavailable.overall).toBe("authority-unavailable");
    expect(unavailable.detail).toContain("Nothing is assumed ready.");
  });

  it("claims nothing is configured only once this Mac has actually been searched", () => {
    const searchedAndEmpty = summarize({ providerStatus: "ready", discovery: searched() });

    expect(searchedAndEmpty.overall).toBe("none-configured");
    expect(searchedAndEmpty.headline).toBe("No provider is configured");
  });

  it("names the unfinished search instead of reporting no provider is configured", () => {
    const beforeAnyScan = summarize({ discovery: { scanning: false } });
    const duringFirstScan = summarize({ discovery: { scanning: true } });
    const duringRescan = summarize({ discovery: { ...searched(), scanning: true } });
    const afterFailedScan = summarize({
      discovery: { scanning: false, message: "Discovery scan failed." },
    });
    const afterPartialScan = summarize({
      discovery: {
        scanning: false,
        snapshot: { status: "partial", candidates: [] } as unknown as DiscoverySnapshot,
      },
    });

    for (const summary of [
      beforeAnyScan,
      duringFirstScan,
      duringRescan,
      afterFailedScan,
      afterPartialScan,
    ]) {
      expect(summary.overall).toBe("checking");
      expect(summary.headline).toBe("Octant has not finished checking this Mac");
    }
    expect(duringFirstScan.detail).toContain("still running");
    expect(afterFailedScan.detail).toContain("has not completed");
  });

  it("treats only a completed scan as an answer about this Mac", () => {
    expect(describeFirstRunDiscoveryProgress({ scanning: false })).toBe("unsearched");
    expect(describeFirstRunDiscoveryProgress({ scanning: true })).toBe("scanning");
    expect(describeFirstRunDiscoveryProgress({ ...searched(), scanning: true })).toBe("scanning");
    expect(describeFirstRunDiscoveryProgress(searched())).toBe("searched");
    expect(
      describeFirstRunDiscoveryProgress({ scanning: false, message: "Discovery scan failed." }),
    ).toBe("unsearched");
    expect(
      describeFirstRunDiscoveryProgress({
        scanning: false,
        snapshot: { status: "cancelled" } as unknown as DiscoverySnapshot,
      }),
    ).toBe("unsearched");
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

    const summary = summarize({
      instances: [instance()],
      discovery: { scanning: false, snapshot },
    });

    expect(summary.detectedCount).toBe(1);
  });
});

describe("first-run discovery notice", () => {
  it("names an incomplete scan and offers a retry rather than implying a full search", () => {
    const cancelled = describeDiscoveryNotice(
      {
        scanning: false,
        snapshot: { status: "cancelled" } as DiscoverySnapshot,
      },
      "darwin",
    );

    expect(cancelled).toEqual({
      tone: "attention",
      message:
        "The scan for installed providers was cancelled. Some installed providers may be missing from this list.",
      retryable: true,
    });
    expect(
      describeDiscoveryNotice({ scanning: false, message: "Discovery scan failed." }, "darwin"),
    ).toMatchObject({ tone: "attention", retryable: true });
    expect(describeDiscoveryNotice({ scanning: true }, "darwin")).toMatchObject({ tone: "info" });
    expect(
      describeDiscoveryNotice(
        {
          scanning: false,
          snapshot: { status: "completed" } as DiscoverySnapshot,
        },
        "darwin",
      ),
    ).toBeUndefined();
  });

  it("says a re-scan is running instead of repeating the outcome it is retrying", () => {
    expect(
      describeDiscoveryNotice(
        {
          scanning: true,
          snapshot: { status: "partial" } as DiscoverySnapshot,
        },
        "darwin",
      ),
    ).toEqual({
      tone: "info",
      message: "Checking this Mac for installed providers…",
      retryable: false,
    });
  });
});

describe.each([
  {
    hostPlatform: "linux",
    computer: "this computer",
    unlock: "Unlock this computer's credential store or sign in again.",
  },
  {
    hostPlatform: "darwin",
    computer: "this Mac",
    unlock: "Unlock the login keychain or sign in again.",
  },
] as const)("first-run copy on a $hostPlatform host", (host) => {
  const onHost = (overrides: Partial<FirstRunReadinessInput>) =>
    summarize({ hostPlatform: host.hostPlatform, ...overrides });

  it("names the host's computer while its search for providers is unfinished", () => {
    const scanning = onHost({ discovery: { scanning: true } });
    const unsearched = onHost({ discovery: { scanning: false } });

    expect(scanning.headline).toBe(`Octant has not finished checking ${host.computer}`);
    expect(scanning.detail).toBe(
      `The search for installed providers is still running. Octant claims nothing about ${host.computer} until it finishes.`,
    );
    expect(unsearched.detail).toBe(
      `The search for installed providers has not completed, so Octant cannot say whether one is installed. Check ${host.computer} again to finish it.`,
    );
    expect(describeDiscoveryNotice({ scanning: true }, host.hostPlatform)?.message).toBe(
      `Checking ${host.computer} for installed providers…`,
    );
  });

  it("names the host's computer where it found runtimes that are not configured", () => {
    const summary = onHost({
      discovery: searched([{ driverKind: "codex", displayName: "Codex" }]),
    });

    expect(summary.detail).toBe(
      `Octant detected 1 installed runtime on ${host.computer}. Enable one in provider settings to send a message.`,
    );
  });

  it("names the host's credential store when a stored credential cannot be read", () => {
    const summary = onHost({
      instances: [instance()],
      observedByInstance: new Map([
        [instance().id, observed({ readiness: "ready", credentialStatus: "unavailable" })],
      ]),
    });

    expect(summary.providers[0]?.detail).toBe(
      `Octant cannot read this provider's stored credential. ${host.unlock}`,
    );
  });
});
