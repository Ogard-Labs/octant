import { decodeProviderInstance, decodeProviderObservedState } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  driverLabel,
  incompatibleReadinessFacts,
  providerProcessFailureSummary,
  providerRefusalGuidance,
  providerRowReadinessLabel,
} from "./providerSettingsPresentation";

describe("provider Settings presentation", () => {
  it("tells a person with a stored fx provider why fx is not offered and that their data is kept", () => {
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000095",
      displayName: "fx local",
      driverKind: "fx",
      configuration: {
        kind: "fx-acp",
        binaryPath: "/Users/example/.local/bin/fx",
        authentication: "api-key",
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    });
    const blocked = decodeProviderObservedState({
      instanceId: instance.id,
      readiness: "unavailable",
      processState: "stopped",
      models: [],
      capabilities: Object.fromEntries(
        [
          "streaming",
          "resume",
          "interruption",
          "approvals",
          "userQuestions",
          "reasoning",
          "usage",
          "toolActivity",
          "fileChanges",
          "diffs",
          "taskProgress",
          "nativeChildAgents",
          "harnessAutoReview",
          "nativeAttachments",
          "nativeWebResearch",
          "appManagedTools",
          "citations",
        ].map((capability) => [capability, "unavailable"]),
      ),
      reason: "driver-not-admitted",
      observedAt: "2026-07-15T10:00:00.000Z",
    });
    const guidance = providerRefusalGuidance(instance, blocked);
    expect(guidance?.reason).toMatch(/fx is not offered yet.*certificates/);
    expect(guidance?.nextStep).toMatch(/provider and its threads are kept/);
  });

  it("names every image profile driver kind, not only chat and code runtimes", () => {
    expect(driverLabel("openai-image")).toBe("OpenAI Image");
    expect(driverLabel("gemini-native-image")).toBe("Gemini Image");
    expect(driverLabel("bfl-image")).toBe("Black Forest Labs Image");
    expect(driverLabel("ideogram-image")).toBe("Ideogram Image");
  });

  it("labels an outside driver as one and explains that it is not admitted, never borrowing a bundled name", () => {
    expect(driverLabel("outside-harness-endpoint")).toBe("Outside driver");
    const instance = decodeProviderInstance({
      id: "80000000-0000-4000-8000-000000000094",
      displayName: "Local chat server",
      driverKind: "outside-harness-endpoint",
      configuration: {
        kind: "outside-harness-endpoint",
        driver: {
          extensionId: "00000000-0000-4000-8000-000000000911",
          packageId: "00000000-0000-4000-8000-000000000912",
          componentId: "provider-driver",
          version: "1.2.0",
          digest: `sha256:${"a".repeat(64)}`,
        },
        baseUrl: "http://127.0.0.1:8080/",
        modelIds: ["local-model"],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    });
    const blocked = decodeProviderObservedState({
      instanceId: instance.id,
      readiness: "unavailable",
      processState: "stopped",
      models: [],
      capabilities: Object.fromEntries(
        [
          "streaming",
          "resume",
          "interruption",
          "approvals",
          "userQuestions",
          "reasoning",
          "usage",
          "toolActivity",
          "fileChanges",
          "diffs",
          "taskProgress",
          "nativeChildAgents",
          "harnessAutoReview",
          "nativeAttachments",
          "nativeWebResearch",
          "appManagedTools",
          "citations",
        ].map((capability) => [capability, "unavailable"]),
      ),
      reason: "driver-not-admitted",
      observedAt: "2026-07-15T10:00:00.000Z",
    });
    expect(providerRefusalGuidance(instance, blocked)).toEqual({
      reason: "This provider's driver package is not admitted, so it offers no models.",
      nextStep:
        "Octant runs this provider only once its driver package is installed, trusted, and enabled. After an update, trusting the new version moves this provider to it.",
    });
    expect(
      providerRefusalGuidance(instance, {
        ...blocked,
        readiness: "incompatible",
        reason: "driver-incompatible",
      }),
    ).toEqual({
      reason: "This provider's driver package does not speak a protocol Octant can use.",
      nextStep:
        "Octant stopped the driver. Install a version of the package built for this Octant, then check the connection again.",
    });
    // A driver has no binary path a person could fix; Octant starts it itself.
    expect(
      providerRefusalGuidance(instance, {
        ...blocked,
        reason: "runtime-unavailable",
      }),
    ).toEqual({
      reason: "Octant could not start this provider's driver, or the driver stopped.",
      nextStep:
        "Check the connection again. If the driver keeps stopping, Octant holds this version until you trust another version.",
    });
    // A journaled crash-limit hold says why, and that only another trusted
    // version lifts it; a restart does not.
    const held = decodeProviderInstance({
      ...instance,
      driverQuarantine: {
        reason: "crash-limit",
        digest: `sha256:${"a".repeat(64)}`,
        quarantinedAt: "2026-07-15T10:05:00.000Z",
      },
    });
    const heldGuidance = {
      reason:
        "This provider's driver stopped three times within a minute, so Octant holds this version of it.",
      nextStep:
        "Restarting Octant does not lift the hold. Install another version of the driver package and trust it; this provider moves to it.",
    };
    expect(providerRefusalGuidance(held, { ...blocked, reason: "runtime-unavailable" })).toEqual(
      heldGuidance,
    );
    // Shown from the provider's own record, even before any check has run.
    expect(providerRefusalGuidance(held, undefined)).toEqual(heldGuidance);
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
      reason: "The installed OpenCode runtime is incompatible.",
      nextStep: "Review the installed OpenCode version, then check the connection again.",
    });
    expect(incompatibleReadinessFacts(instance, observed)).toEqual(
      expect.arrayContaining([
        {
          label: "Host check",
          value: "The installed OpenCode runtime is incompatible.",
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

  it("names how an unavailable provider process last failed and at which stage", () => {
    const observed = decodeProviderObservedState({
      instanceId: "90000000-0000-4000-8000-000000000010",
      readiness: "unavailable",
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
        harnessAutoReview: "unsupported",
        nativeAttachments: "unavailable",
        nativeWebResearch: "unavailable",
        appManagedTools: "unavailable",
        citations: "unavailable",
      },
      diagnostic: { stage: "launch", kind: "exited", exitCode: 65 },
      observedAt: "2026-07-14T10:00:00.000Z",
    });

    expect(providerProcessFailureSummary("OpenCode CLI", observed)).toBe(
      "OpenCode CLI exited with code 65 during launch.",
    );
    expect(providerProcessFailureSummary("OpenCode CLI", undefined)).toBeUndefined();
  });
});
