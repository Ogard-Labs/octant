import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeAcpDriver, type AcpClientPort } from "./acpDriver";
import type { AcpConnection, AcpProcessPort } from "./acpProcess";
import { acpProviderProfiles, type AcpProviderProfile } from "./acpProfiles";
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

function createFixture(profile: AcpProviderProfile) {
  const client = new ConformanceClient(profile);
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
        options: [{ value: "default", name: "Default" }],
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
  respondPermission = async () => undefined;
  onNotification(listener: Parameters<AcpClientPort["onNotification"]>[0]) {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }
  onRequest(listener: Parameters<AcpClientPort["onRequest"]>[0]) {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }
  prompt = async (sourceSessionId: string) => {
    const notify = (update: Record<string, unknown>) =>
      this.#notifications.forEach((listener) =>
        listener({
          kind: "notification",
          method: "session/update",
          params: { sessionId: sourceSessionId, update },
        }),
      );
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
