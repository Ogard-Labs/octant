import { decodeProviderInstance, decodeProviderObservedState } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  driverLabel,
  incompatibleReadinessFacts,
  providerRefusalGuidance,
  providerRowReadinessLabel,
} from "./providerSettingsPresentation";

describe("provider Settings presentation", () => {
  it("names every image profile driver kind, not only chat and code runtimes", () => {
    expect(driverLabel("openai-image")).toBe("OpenAI Image");
    expect(driverLabel("gemini-native-image")).toBe("Gemini Image");
    expect(driverLabel("bfl-image")).toBe("Black Forest Labs Image");
    expect(driverLabel("ideogram-image")).toBe("Ideogram Image");
  });

  it("turns technical readiness states into compact next-action labels", () => {
    expect(providerRowReadinessLabel("unauthenticated", 0)).toBe("Sign in required");
    expect(providerRowReadinessLabel("incompatible", 0)).toBe("Incompatible");
    expect(providerRowReadinessLabel("degraded", 0)).toBe("Needs setup");
    expect(providerRowReadinessLabel("degraded", 4)).toBe("Limited");
    expect(providerRowReadinessLabel("ready", 4)).toBe("Ready");
  });

  it("maps a typed OpenCode probe refusal to reason-specific copy and next-step guidance", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000093",
      displayName: "OpenCode local",
      driverKind: "opencode",
      configuration: {
        kind: "opencode-cli",
        binaryPath: "/opt/homebrew/bin/opencode",
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
      detectedVersion: "v0.0.0-beta-18721",
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
        harnessAutoReview: "unsupported",
        nativeAttachments: "unavailable",
        nativeWebResearch: "unavailable",
        appManagedTools: "unavailable",
        citations: "unavailable",
      },
      reason: "runtime-incompatible",
      observedAt: "2026-07-14T10:00:00.000Z",
    });
    expect(providerRefusalGuidance(instance, observed)).toEqual({
      reason:
        "This OpenCode runtime is discovery-only and cannot carry Octant's session permission rules yet.",
      nextStep: "Use a supported OpenCode 1.x runtime, then check the connection again.",
    });
    expect(incompatibleReadinessFacts(instance, observed)).toEqual(
      expect.arrayContaining([
        {
          label: "Host check",
          value:
            "This OpenCode runtime is discovery-only and cannot carry Octant's session permission rules yet.",
        },
        { label: "Version", value: "v0.0.0-beta-18721" },
      ]),
    );
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
        harnessAutoReview: "unsupported",
        nativeAttachments: "unavailable",
        nativeWebResearch: "unavailable",
        appManagedTools: "unavailable",
        citations: "unavailable",
      },
      message: "Claude initialization version did not match the configured binary.",
      diagnostic: {
        stage: "initialization",
        kind: "exited",
        exitCode: 78,
        stderrContext: "Provider process rejected its configured arguments.",
      },
      observedAt: "2026-07-14T10:00:00.000Z",
    });

    expect(incompatibleReadinessFacts(instance, observed)).toEqual([
      {
        label: "Host check",
        value: "Claude initialization version did not match the configured binary.",
      },
      { label: "Binary", value: "/opt/homebrew/bin/claude" },
      { label: "Version", value: "2.1.211" },
      { label: "Failure stage", value: "Initialization" },
      { label: "Process result", value: "Exited with code 78" },
      {
        label: "Safe stderr context",
        value: "Provider process rejected its configured arguments.",
      },
      { label: "Authentication", value: "Claude subscription" },
      { label: "Capabilities", value: "Not confirmed" },
    ]);
  });
});
