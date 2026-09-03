import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { Effect, PubSub, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type {
  ClaudeAgentSdkPort,
  ClaudeDecodedMessage,
  ClaudeOpenQueryInput,
  ClaudeQueryPort,
  ClaudeSessionMetadata,
} from "./claudeAgentSdkPort";
import {
  makeClaudeDriver,
  type ClaudeResumeIdentity,
  type ClaudeResumeIdentityPort,
} from "./claudeDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import type { ClaudeEnvironmentScope } from "./claudeEnvironment";
import type { ClaudeProcessPort } from "./claudeProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000721");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000722");
const staleSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000723");
const modelId = "claude-sonnet" as ProviderModelId;
const projectRoot = "/tmp/octant-claude-conformance";
const occurredAt = "2026-07-17T00:00:00.000Z";

describe("Claude provider conformance", () => {
  it("passes the real driver lifecycle, capabilities, resume, failure, and cleanup harness", async () => {
    const opened: ConformanceQuery[] = [];
    const histories = new Map<string, ClaudeSessionMetadata>();
    let runtimeNumber = 0;
    const sdk: ClaudeAgentSdkPort = {
      openQuery: (input) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const query = new ConformanceQuery(
              input,
              input.resumeSessionId ?? `sdk-conformance-${++runtimeNumber}`,
            );
            opened.push(query);
            histories.set(query.sdkSessionId, {
              sessionId: query.sdkSessionId,
              projectRoot: input.projectRoot,
              lastModified: 1,
            });
            return query;
          }),
          (query) => query.close(),
        ),
      findSession: ({ sessionId: sdkSessionId, projectRoot: root }) =>
        Effect.succeed(
          histories.get(sdkSessionId)?.projectRoot === root
            ? histories.get(sdkSessionId)
            : undefined,
        ),
    };
    const identities = new Map<string, ClaudeResumeIdentity>();
    const resumeIdentityPort: ClaudeResumeIdentityPort = {
      lookup: async ({ sdkSessionId }, signal) => {
        if (signal.aborted) throw new Error("cancelled");
        return identities.get(sdkSessionId);
      },
      put: async (identity, signal) => {
        if (signal.aborted) throw new Error("cancelled");
        identities.set(identity.sdkSessionId, identity);
      },
      remove: async ({ sdkSessionId }, signal) => {
        if (signal.aborted) throw new Error("cancelled");
        identities.delete(sdkSessionId);
      },
    };
    const registry = new ProviderRuntimeRegistry();
    const driver = makeClaudeDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "subscription",
      process: {
        probeVersion: () => Effect.succeed("2.1.211"),
        probeSubscription: () => Effect.succeed("authenticated" as const),
        spawn: vi.fn() as ClaudeProcessPort["spawn"],
      },
      sdk,
      runtimeRegistry: registry,
      resumeIdentityPort,
      permissionPersistence: () => "current-session",
      makeEnvironmentScope: () =>
        Effect.acquireRelease(
          Effect.succeed({
            environment: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/provider-native" },
          } satisfies ClaudeEnvironmentScope),
          () => Effect.void,
        ),
      isProjectConfinedPath: (root, path) => path.startsWith(`${root}/`),
      clock: () => occurredAt,
      correlationId: () => "80000000-0000-4000-8000-000000000724",
      requestId: (() => {
        let id = 0;
        return () => `request-${++id}`;
      })(),
      taskId: () => "task-1",
      toolCallId: () => "tool-1",
      startupTimeoutMs: 500,
      interruptTimeoutMs: 500,
    });

    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: { sessionId, prompt: "conformance turn", attachments: [], tools: [] },
      resume: {
        sessionId,
        resumeCursor: { driverKind: "claude", value: "sdk-conformance-2" },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId: staleSessionId,
        resumeCursor: { driverKind: "claude", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: { sessionId, requestId: "unknown", approved: false },
      unknownUserInput: { sessionId, requestId: "unknown", answer: "none" },
      expectedEventKinds: [
        "text-delta",
        "reasoning-delta",
        "tool-start",
        "usage",
        "tool-progress",
        "file-change",
        "diff",
        "tool-success",
        "task-progress",
        "approval-request",
        "user-input-request",
        "usage",
        "interrupted",
      ],
      expectedFailureCategories: {
        staleResume: "stale-resume",
        unknownApproval: "protocol",
        unknownUserInput: "protocol",
      },
      isReleased: () => opened.length > 0 && opened.every((query) => query.closed),
    });
    const chatEvidence = await runProviderChatConformance({
      driver,
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
      isReleased: () => opened.length > 0 && opened.every((query) => query.closed),
    });
    recordProviderConformanceEvidence("claude", evidence);
    recordProviderChatConformanceEvidence("claude", chatEvidence);

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
    expect(chatEvidence).toMatchObject({ nativeAttachmentHonest: true, released: true });
  });
});

class ConformanceQuery implements ClaudeQueryPort {
  readonly #pubsub = Effect.runSync(PubSub.unbounded<ClaudeDecodedMessage>());
  readonly messages: Stream.Stream<ClaudeDecodedMessage, ProviderFailure>;
  readonly sessionId: Effect.Effect<string, ProviderFailure>;
  readonly initialization = {
    models: [
      {
        id: modelId,
        displayName: "Claude Sonnet",
        description: "Conformance model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"] as const,
      },
    ],
    account: { ready: true as const, apiProvider: "firstParty" as const },
  };
  readonly supportedModels = () => Effect.succeed(this.initialization.models);
  readonly accountInfo = () => Effect.succeed(this.initialization.account);
  readonly setPermissionMode = () => Effect.void;
  readonly close = () =>
    Effect.sync(() => {
      this.closed = true;
    });
  closed = false;

  constructor(
    readonly input: ClaudeOpenQueryInput,
    readonly sdkSessionId: string,
  ) {
    this.sessionId = Effect.succeed(sdkSessionId);
    this.messages = Stream.concat(
      Stream.succeed(initialized(input, sdkSessionId)),
      Stream.fromPubSub(this.#pubsub),
    );
  }

  readonly send: ClaudeQueryPort["send"] = () =>
    Effect.tryPromise({
      try: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await this.emit({
          kind: "stream-event",
          sessionId: this.sdkSessionId,
          event: { kind: "text-delta", index: 0, text: "hello" },
        });
        await this.emit({
          kind: "stream-event",
          sessionId: this.sdkSessionId,
          event: { kind: "reasoning-delta", index: 1, text: "reason" },
        });
        await this.emit({
          kind: "assistant",
          sessionId: this.sdkSessionId,
          messageId: "message-1",
          content: [
            {
              kind: "tool-use",
              toolUseId: "edit-1",
              toolName: "Edit",
              input: {
                file_path: `${projectRoot}/src/app.ts`,
                old_string: "private-old",
                new_string: "private-new",
              },
            },
          ],
          usage: usage(),
        });
        await this.emit({
          kind: "tool-progress",
          sessionId: this.sdkSessionId,
          toolUseId: "edit-1",
          toolName: "Edit",
          elapsedSeconds: 1,
        });
        await this.emit({
          kind: "tool-results",
          sessionId: this.sdkSessionId,
          results: [{ toolUseId: "edit-1", isError: false }],
        });
        await this.emit({
          kind: "task",
          sessionId: this.sdkSessionId,
          subtype: "task_started",
          taskId: "provider-task-1",
          description: "Conformance task",
        });
        await Promise.resolve();
        await this.requestApproval();
        await this.requestQuestion();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
      catch: () => ({ category: "provider-failed", message: "Claude fixture failed." }),
    });

  readonly interrupt = () =>
    Effect.promise(async () => {
      await this.emit({
        kind: "result",
        sessionId: this.sdkSessionId,
        outcome: "error",
        subtype: "error_during_execution",
        stopReason: null,
        terminalReason: "aborted_streaming",
        usage: usage(),
        permissionDenials: [],
      });
    });

  private async requestApproval(): Promise<void> {
    const input = { command: "pwd", cwd: projectRoot };
    const signal = new AbortController().signal;
    const request = {
      sessionId: this.sdkSessionId,
      projectRoot,
      toolName: "Bash",
      input,
      toolUseId: "approval-1",
      signal,
    } as const;
    const gate = await this.input.preToolUse(request);
    if (gate.behavior === "allow") {
      void this.input.canUseTool({
        toolName: request.toolName,
        input,
        toolUseId: request.toolUseId,
        signal,
      });
    }
  }

  private async requestQuestion(): Promise<void> {
    const input = {
      questions: [
        {
          question: "Continue?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiSelect: false,
        },
      ],
    };
    const signal = new AbortController().signal;
    const request = {
      sessionId: this.sdkSessionId,
      projectRoot,
      toolName: "AskUserQuestion",
      input,
      toolUseId: "question-1",
      signal,
    } as const;
    const gate = await this.input.preToolUse(request);
    if (gate.behavior === "allow") {
      void this.input.canUseTool({
        toolName: request.toolName,
        input,
        toolUseId: request.toolUseId,
        signal,
      });
    }
  }

  private emit(message: ClaudeDecodedMessage): Promise<boolean> {
    return Effect.runPromise(PubSub.publish(this.#pubsub, message));
  }
}

function initialized(input: ClaudeOpenQueryInput, sdkSessionId: string): ClaudeDecodedMessage {
  return {
    kind: "initialized",
    sessionId: sdkSessionId,
    projectRoot: input.projectRoot,
    model: input.model,
    requestedModel: input.model,
    permissionMode:
      input.executionPolicy === "full-access"
        ? "bypassPermissions"
        : input.executionPolicy === "plan"
          ? "plan"
          : "default",
    tools: [...input.tools],
    capabilities: ["interrupt_receipt_v1"],
    runtimeVersion: "2.1.211",
  };
}

function usage() {
  return {
    inputTokens: 2,
    outputTokens: 3,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}
