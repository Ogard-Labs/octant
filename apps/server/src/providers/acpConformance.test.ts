import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { runRemotePlacementConformance } from "@octant/provider-sdk/process-placement-conformance";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeAcpDriver, type AcpClientPort } from "./acpDriver";
import type { AcpConnection, AcpProcessPort } from "./acpProcess";
import { acpProviderProfiles, type AcpProviderProfile } from "./acpProfiles";
import { acpRemotePlacement } from "./acpPlacement";
import { acpStandInTarget, placeableAcpProfile } from "./acpPlacement.test-support";
import type { ProviderPlacedLaunch } from "@octant/provider-sdk/driver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000331");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000332");
const modelId = "agent-k2" as ProviderModelId;
const projectRoot = "/tmp/octant-acp-conformance";
const managedHome = "/tmp/octant-acp-conformance-home";

it("keeps browser authentication reserved for non-CLI profiles", () => {
  expect(
    Object.values(acpProviderProfiles).every(
      (profile) => profile.authentication.kind === "provider-owned",
    ),
  ).toBe(true);
});

describe.each(Object.values(acpProviderProfiles))(
  "ACP provider conformance ($displayName)",
  (profile) => {
    it("passes negotiated lifecycle, authority, resume, and cleanup conformance", async () => {
      const fixture = createFixture(profile);
      const evidence = await runProviderConformance({
        driver: fixture.driver,
        probeInput: { instanceId },
        acquireInput: { instanceId, projectRoot, mode: "code" },
        sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
        turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
        resume: {
          sessionId,
          resumeCursor: { driverKind: profile.kind, value: "agent-session-2" },
          executionPolicy: "approval-gated",
        },
        staleResume: {
          sessionId,
          resumeCursor: { driverKind: profile.kind, value: "stale" },
          executionPolicy: "approval-gated",
        },
        unknownApproval: { sessionId, requestId: "unknown", approved: false },
        unknownUserInput: { sessionId, requestId: "unknown", answer: "none" },
        expectedEventKinds: [
          "text-delta",
          "reasoning-delta",
          "tool-start",
          "tool-success",
          "task-progress",
          "task-list",
          "approval-request",
          ...(profile.userQuestions === "supported" ? (["user-input-request"] as const) : []),
          "interrupted",
        ],
        expectedFailureCategories: {
          staleResume: "stale-resume",
          unknownApproval: "protocol",
          unknownUserInput: profile.userQuestions === "supported" ? "protocol" : "unsupported",
        },
        isReleased: () => fixture.active() === 0 && fixture.released() >= 3,
      });
      recordProviderConformanceEvidence(profile.kind, evidence);

      expect(evidence).toEqual({
        probed: true,
        capabilityHonest: true,
        usageCapabilityHonest: true,
        researchCapabilityHonest: true,
        citationsCapabilityHonest: true,
        streamedInOrder: true,
        interrupted: true,
        resumed: true,
        staleResumeRejected: true,
        unknownApprovalRejected: true,
        unknownUserInputRejected: true,
        failureClassified: true,
        released: true,
      });
    });

    it.skipIf(acpRemotePlacement(profile, undefined) !== undefined)(
      "reports placement on a remote target unsupported, and launches nothing when handed one",
      async () => {
        const fixture = createFixture(profile);
        const evidence = await runRemotePlacementConformance({
          driver: fixture.driver,
          acquireInput: { instanceId, projectRoot, mode: "code" },
          sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
          turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
          target: {
            kind: "remote",
            executable: "/opt/agent/bin/agent",
            launch: () => Effect.fail({ category: "unavailable", message: "No target." }),
          },
          localLaunches: () => fixture.active() + fixture.released(),
          isReleased: () => fixture.active() === 0,
        });
        expect(evidence).toMatchObject({ claim: "unsupported", refusedBeforeAnyLaunch: true });
      },
    );

    it("passes chat conformance with explicit unsupported native attachments", async () => {
      const fixture = createFixture(profile);
      const evidence = await runProviderChatConformance({
        driver: fixture.driver,
        probeInput: { instanceId },
        acquireInput: { instanceId, projectRoot, mode: "code" },
        sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
        turn: {
          sessionId,
          prompt: "hello",
          attachments: [
            {
              attachmentId: "attachment-1",
              displayName: "diagram.png",
              mediaType: "image/png",
              bytes: new Uint8Array([1, 2, 3]),
            },
          ],
          tools: [],
        },
        isReleased: () => fixture.active() === 0 && fixture.released() >= 1,
      });
      recordProviderChatConformanceEvidence(profile.kind, evidence);
      expect(evidence).toMatchObject({ nativeAttachmentHonest: true, released: true });
    });
  },
);

describe("ACP placement on a remote target", () => {
  it("places a profile whose whole launch can be stated there in every confined posture, passing placement conformance", async () => {
    const fixture = createFixture(placeableAcpProfile, new AnsweringClient(placeableAcpProfile));
    const launches: ProviderPlacedLaunch[] = [];
    expect(fixture.driver.remotePlacement).toEqual({
      postures: ["plan", "approval-gated", "auto-accept-edits"],
      appToolTransport: "stdio",
    });
    const evidence = await runRemotePlacementConformance({
      driver: fixture.driver,
      acquireInput: { instanceId, projectRoot: "/home/build/app", mode: "code" },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
      target: acpStandInTarget({ launches }),
      localLaunches: () => fixture.active() + fixture.released(),
      isReleased: () => fixture.active() === 0,
    });
    expect(evidence).toEqual({
      claim: "supported",
      refusedBeforeAnyLaunch: false,
      ranOnTarget: true,
      refusedWithoutLocalFallback: true,
      placedProcessesStopped: true,
    });
    // The agent ran at the person's path with the profile's own arguments,
    // signing in with the same folder under the target user's home.
    expect(launches.length).toBe(3);
    for (const launch of launches) {
      expect(launch).toEqual({
        executable: "/opt/fixture-agent/bin/fixture-agent",
        args: ["--acp"],
        accountState: [
          { path: ".fixture-agent", access: "read-write", variable: "FIXTURE_AGENT_HOME" },
        ],
      });
    }
  });

  it("places GitHub Copilot through its declaration, passing placement conformance with its guard, denied Project entries, and sign-in folder", async () => {
    const profile = acpProviderProfiles.copilot;
    const fixture = createFixture(profile, new AnsweringClient(profile));
    const launches: ProviderPlacedLaunch[] = [];
    const evidence = await runRemotePlacementConformance({
      driver: fixture.driver,
      acquireInput: { instanceId, projectRoot: "/home/build/app", mode: "code" },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
      target: acpStandInTarget({
        launches,
        executable: "/home/build/.local/bin/copilot",
        agentName: profile.process.agentName,
        version: profile.process.minimumVersion.join("."),
      }),
      localLaunches: () => fixture.active() + fixture.released(),
      isReleased: () => fixture.active() === 0,
    });
    expect(evidence).toMatchObject({ claim: "supported", ranOnTarget: true });
    expect(launches.length).toBeGreaterThan(0);
    for (const launch of launches) {
      expect(launch).toEqual({
        executable: "/home/build/.local/bin/copilot",
        args: ["--acp"],
        accountState: [{ path: ".copilot", access: "read-write", variable: "COPILOT_HOME" }],
        fixedVariables: { NO_COLOR: "1" },
        deniedRootEntries: profile.process.forbiddenRootEntries,
      });
    }
  });

  it("keeps no placed agent for a later session, even of a release whose sessions are kept here", async () => {
    // Locally a completed session of this release is kept warm for its next
    // turn; a placed one was admitted for one placement and stops with it.
    const kept = { ...placeableAcpProfile, retainedSessionVersions: ["0.4.2"] };
    const fixture = createFixture(kept, new AnsweringClient(kept));
    await expect(
      runRemotePlacementConformance({
        driver: fixture.driver,
        acquireInput: { instanceId, projectRoot: "/home/build/app", mode: "code" },
        sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
        turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
        target: acpStandInTarget({ version: "0.4.2" }),
        localLaunches: () => fixture.active() + fixture.released(),
        isReleased: () => fixture.active() === 0,
      }),
    ).resolves.toMatchObject({ claim: "supported", placedProcessesStopped: true });
  });
});

function createFixture(
  profile: AcpProviderProfile,
  client: AcpClientPort = new ConformanceClient(profile),
) {
  let active = 0;
  let released = 0;
  const initialized: AcpConnection["initialized"] = {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {} },
    },
    authMethods: [{ id: "provider-auth" }],
    agentInfo: { name: profile.process.agentName, version: "0.0.0-dev" },
    _meta: { grokShell: true },
  };
  const processPort: AcpProcessPort = {
    start: (input) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          active += 1;
          return {
            version: "7.4.11",
            pid: 331,
            root: input.root,
            initialized,
            acp: {} as AcpConnection["acp"],
            exited: new Promise<void>(() => undefined),
          };
        }),
        () =>
          Effect.sync(() => {
            active -= 1;
            released += 1;
          }),
      ),
  };
  return {
    driver: makeAcpDriver({
      profile,
      instanceId,
      binaryPath: "/Users/example/.local/bin/agent",
      managedHome,
      process: processPort,
      runtimeRegistry: new ProviderRuntimeRegistry(),
      ...(profile.authentication.kind === "delegated-browser"
        ? { authentication: "subscription" as const }
        : {}),
      clientFactory: () => client,
      clock: () => "2026-07-17T10:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000333",
      requestId: (() => {
        let id = 0;
        return () => `request-${++id}`;
      })(),
    }),
    active: () => active,
    released: () => released,
  };
}

class ConformanceClient implements AcpClientPort {
  readonly #notifications = new Set<Parameters<AcpClientPort["onNotification"]>[0]>();
  readonly #requests = new Set<Parameters<AcpClientPort["onRequest"]>[0]>();
  #session = 0;
  #cancel: (() => void) | undefined;
  readonly configOptions;

  constructor(readonly profile: AcpProviderProfile) {
    this.configOptions = [
      {
        type: "select" as const,
        id: "model",
        name: "Model",
        currentValue: "agent-k2",
        options: [{ value: "agent-k2", name: "Agent K2" }],
      },
      {
        type: "select" as const,
        id: profile.reasoningOptionId,
        name: "Reasoning",
        currentValue: "on",
        options: [{ value: "on", name: "On" }],
      },
      {
        type: "select" as const,
        id: "mode",
        name: "Mode",
        currentValue: "default",
        // Offer the mode the conformance turns select, as a real agent does.
        options: [...new Set(["default", profile.sessionMode("code", "approval-gated")])].map(
          (value) => ({ value, name: value }),
        ),
      },
    ];
  }

  authenticate = async () => undefined;
  startBrowserAuthentication = async () => ({
    attemptId: "attempt",
    signInUrl: "https://auth.example/attempt",
    expiresAt: "2026-07-17T11:00:00.000Z",
  });
  completeBrowserAuthentication = async () => undefined;
  closeSession = async () => undefined;
  newSession = async () => {
    const sessionId = `agent-session-${++this.#session}`;
    if (this.profile.reviewedCommands !== undefined) {
      this.#notifications.forEach((listener) =>
        listener({
          kind: "notification",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: this.profile.reviewedCommands!.map((name) => ({
                name,
                description: name,
              })),
            },
          },
        }),
      );
    }
    return { sessionId, configOptions: this.configOptions };
  };
  loadSession = async (source: string) => {
    if (source === "stale") throw new Error("stale");
    return { sessionId: source, configOptions: this.configOptions };
  };
  resumeSession = this.loadSession;
  setConfigOption = async () => ({ configOptions: this.configOptions });
  call = async <T = unknown>() => ({}) as T;
  respondPermission = async () => undefined;
  respond = async () => undefined;
  reject = async () => undefined;
  onNotification(listener: Parameters<AcpClientPort["onNotification"]>[0]) {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }
  onRequest(listener: Parameters<AcpClientPort["onRequest"]>[0]) {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }
  protected announce(sourceSessionId: string, update: Record<string, unknown>): void {
    this.#notifications.forEach((listener) =>
      listener({
        kind: "notification",
        method: "session/update",
        params: { sessionId: sourceSessionId, update },
      }),
    );
  }
  prompt = async (sourceSessionId: string): Promise<{ stopReason: string }> => {
    const notify = (update: Record<string, unknown>) => this.announce(sourceSessionId, update);
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
    notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } });
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "provider-tool",
      title: "Read",
      status: "in_progress",
    });
    notify({ sessionUpdate: "tool_call_update", toolCallId: "provider-tool", status: "completed" });
    notify({ sessionUpdate: "plan", entries: [{ content: "Inspect", status: "in_progress" }] });
    const request = (id: string, title: string, options: ReadonlyArray<Record<string, string>>) =>
      this.#requests.forEach((listener) =>
        listener({
          kind: "request",
          id,
          method: "session/request_permission",
          params: {
            sessionId: sourceSessionId,
            toolCall: { toolCallId: id, title, kind: "edit" },
            options: options as Array<{ optionId: string; name: string; kind: string }>,
          },
        }),
      );
    request("approval", "Write", [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ]);
    if (this.profile.userQuestions === "supported") {
      request("question", "Choose", [
        { optionId: "q0_opt_0", name: "A", kind: "allow_once" },
        { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
      ]);
    }
    return new Promise<{ stopReason: string }>((resolve) => {
      this.#cancel = () => resolve({ stopReason: "cancelled" });
    });
  };
  notify = async () => {
    this.#cancel?.();
    this.#cancel = undefined;
  };
}

/** An agent whose turn answers and ends on its own, as a placed agent's first turn would. */
class AnsweringClient extends ConformanceClient {
  override prompt = async (sourceSessionId: string): Promise<{ stopReason: string }> => {
    this.announce(sourceSessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello from the target" },
    });
    return { stopReason: "end_turn" };
  };
}
