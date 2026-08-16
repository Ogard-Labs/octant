import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeCodexDriver, type CodexClientPort, type CodexThreadStartInput } from "./codexDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import type { CodexAppServerConnection } from "./codexProcess";
import type { CodexServerMessage } from "./codexProtocol";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000211");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000212");
const modelId = "gpt-5.4" as ProviderModelId;
const projectRoot = "/tmp/octant-codex-conformance";

describe("Codex provider conformance", () => {
  it("passes the provider-neutral lifecycle, capability, resume, failure, and cleanup harness", async () => {
    const listeners = new Set<(message: CodexServerMessage) => void>();
    const emit = (message: CodexServerMessage) =>
      listeners.forEach((listener) => listener(message));
    let released = false;
    let startedThread = 0;
    const client: CodexClientPort = {
      accountRead: async () => ({ account: { type: "chatgpt" }, requiresOpenaiAuth: true }),
      modelList: async () => ({ data: [model()], nextCursor: null }),
      threadStart: async (input: CodexThreadStartInput) =>
        thread(`thread-${++startedThread}`, input.cwd),
      threadResume: async ({ threadId }) => {
        if (threadId === "stale") throw new Error("private stale detail");
        return thread(threadId, projectRoot);
      },
      turnStart: async ({ threadId }) => {
        for (const message of runtimeMessages(threadId)) emit(message);
        return { turn: { id: "turn-1", status: "inProgress" } };
      },
      turnInterrupt: async ({ threadId, turnId }) => {
        emit(
          notification("turn/completed", {
            threadId,
            turn: { id: turnId, status: "interrupted" },
          }),
        );
      },
      respondApproval: async () => undefined,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const driver = makeCodexDriver({
      instanceId,
      binaryPath: "/usr/local/bin/codex",
      process: {
        start: () =>
          Effect.acquireRelease(
            Effect.succeed({
              version: "0.144.4",
              pid: 211,
              rpc: {} as CodexAppServerConnection["rpc"],
              exited: new Promise<void>(() => undefined),
            }),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      clientFactory: () => client,
      idleLeaseMs: 0,
      clock: () => "2026-07-15T00:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000213",
      requestId: () => "request-1",
      taskId: () => "task-1",
      toolCallId: (() => {
        let id = 0;
        return () => `tool-${++id}`;
      })(),
    });

    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
      resume: {
        sessionId,
        resumeCursor: { driverKind: "codex", value: "thread-resume" },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId,
        resumeCursor: { driverKind: "codex", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: { sessionId, requestId: "unknown", approved: false },
      unknownUserInput: { sessionId, requestId: "unknown", answer: "none" },
      expectedEventKinds: [
        "text-delta",
        "reasoning-delta",
        "tool-start",
        "tool-progress",
        "tool-success",
        "tool-start",
        "tool-progress",
        "file-change",
        "tool-success",
        "usage",
        "diff",
        "task-progress",
        "approval-request",
        "interrupted",
      ],
      expectedFailureCategories: {
        staleResume: "stale-resume",
        unknownApproval: "protocol",
        unknownUserInput: "unsupported",
      },
      isReleased: () => released,
    });
    recordProviderConformanceEvidence("codex", evidence);

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
    const fixture = createCodexConformanceFixture();
    const evidence = await runProviderChatConformance({
      driver: fixture.driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot },
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
      isReleased: fixture.isReleased,
    });
    recordProviderChatConformanceEvidence("codex", evidence);
    expect(evidence).toMatchObject({ nativeAttachmentHonest: true, released: true });
  });
});

function createCodexConformanceFixture() {
  const listeners = new Set<(message: CodexServerMessage) => void>();
  const emit = (message: CodexServerMessage) => listeners.forEach((listener) => listener(message));
  let released = false;
  const client: CodexClientPort = {
    accountRead: async () => ({ account: { type: "chatgpt" }, requiresOpenaiAuth: true }),
    modelList: async () => ({ data: [model()], nextCursor: null }),
    threadStart: async (input: CodexThreadStartInput) => thread(`thread-1`, input.cwd),
    threadResume: async ({ threadId }) => {
      if (threadId === "stale") throw new Error("private stale detail");
      return thread(threadId, projectRoot);
    },
    turnStart: async ({ threadId }) => {
      for (const message of runtimeMessages(threadId)) emit(message);
      return { turn: { id: "turn-1", status: "inProgress" } };
    },
    turnInterrupt: async () => undefined,
    respondApproval: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    driver: makeCodexDriver({
      instanceId,
      binaryPath: "/usr/local/bin/codex",
      process: {
        start: () =>
          Effect.acquireRelease(
            Effect.succeed({
              version: "0.144.4",
              pid: 211,
              rpc: {} as CodexAppServerConnection["rpc"],
              exited: new Promise<void>(() => undefined),
            }),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      clientFactory: () => client,
      idleLeaseMs: 0,
      clock: () => "2026-07-15T00:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000213",
      requestId: () => "request-1",
      taskId: () => "task-1",
      toolCallId: (() => {
        let id = 0;
        return () => `tool-${++id}`;
      })(),
    }),
    isReleased: () => released,
  };
}

function model() {
  return {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT 5.4",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }],
    defaultReasoningEffort: "high",
    inputModalities: ["text" as const],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  };
}

function thread(id: string, cwd: string) {
  return {
    thread: { id },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
  };
}

function notification(
  method: Extract<CodexServerMessage, { kind: "notification" }>["method"],
  params: unknown,
): CodexServerMessage {
  return { kind: "notification", method, params } as CodexServerMessage;
}

function runtimeMessages(threadId: string): ReadonlyArray<CodexServerMessage> {
  return [
    notification("turn/started", {
      threadId,
      turn: { id: "turn-1", status: "inProgress" },
    }),
    notification("item/agentMessage/delta", {
      threadId,
      turnId: "turn-1",
      itemId: "message-1",
      delta: "hello",
    }),
    notification("item/reasoning/summaryTextDelta", {
      threadId,
      turnId: "turn-1",
      itemId: "reasoning-1",
      summaryIndex: 0,
      delta: "think",
    }),
    notification("item/started", {
      threadId,
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "printf hidden",
        cwd: projectRoot,
        status: "inProgress",
      },
      startedAtMs: 1,
    }),
    notification("item/completed", {
      threadId,
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "printf hidden",
        cwd: projectRoot,
        status: "completed",
        aggregatedOutput: "hidden",
        exitCode: 0,
      },
      completedAtMs: 2,
    }),
    notification("item/started", {
      threadId,
      turnId: "turn-1",
      item: { type: "fileChange", id: "file-1", changes: [], status: "inProgress" },
      startedAtMs: 3,
    }),
    notification("item/completed", {
      threadId,
      turnId: "turn-1",
      item: {
        type: "fileChange",
        id: "file-1",
        changes: [{ path: `${projectRoot}/src/main.ts`, kind: { type: "add" }, diff: "+hidden" }],
        status: "completed",
      },
      completedAtMs: 4,
    }),
    notification("thread/tokenUsage/updated", {
      threadId,
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 3,
          inputTokens: 2,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 1,
        },
        last: {
          totalTokens: 3,
          inputTokens: 2,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 1,
        },
        modelContextWindow: 200_000,
      },
    }),
    notification("turn/diff/updated", {
      threadId,
      turnId: "turn-1",
      diff: "diff --git a/src/main.ts b/src/main.ts\n+x",
    }),
    notification("turn/plan/updated", {
      threadId,
      turnId: "turn-1",
      explanation: null,
      plan: [{ step: "Verify", status: "inProgress" }],
    }),
    {
      kind: "request",
      id: "provider-request-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId: "turn-1",
        itemId: "approval-item-1",
        startedAtMs: 5,
        environmentId: null,
        reason: "hidden",
        command: "hidden",
        cwd: projectRoot,
      },
    },
  ];
}
