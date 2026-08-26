import { decodeProviderInstance, decodeProviderObservedState } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  incompatibleReadinessFacts,
  providerRowReadinessLabel,
} from "./providerSettingsPresentation";

describe("provider Settings presentation", () => {
  it("turns technical readiness states into compact next-action labels", () => {
    expect(providerRowReadinessLabel("unauthenticated", 0)).toBe("Sign in required");
    expect(providerRowReadinessLabel("incompatible", 0)).toBe("Update required");
    expect(providerRowReadinessLabel("degraded", 0)).toBe("Needs setup");
    expect(providerRowReadinessLabel("degraded", 4)).toBe("Limited");
    expect(providerRowReadinessLabel("ready", 4)).toBe("Ready");
  });

  it("names the host incompatibility facts a connection check can record", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000092",
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
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    });
    const observed = decodeProviderObservedState({
      instanceId: instance.id,
      readiness: "incompatible",
      processState: "stopped",
      detectedVersion: "2.1.211",
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
      message: "Claude initialization version did not match the configured binary.",
      observedAt: "2026-07-14T10:00:00.000Z",
    });

    expect(incompatibleReadinessFacts(instance, observed)).toEqual([
      {
        label: "Host check",
        value: "Claude initialization version did not match the configured binary.",
      },
      { label: "Binary", value: "/opt/homebrew/bin/claude" },
      { label: "Version", value: "2.1.211" },
      { label: "Authentication", value: "Claude subscription" },
      { label: "Capabilities", value: "Not confirmed" },
    ]);
  });
});
