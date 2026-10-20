import { readdirSync } from "node:fs";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import type { ProviderDriver, ProviderPagePublishingSource } from "@octant/provider-sdk";
import {
  runProviderConformance,
  runSessionCompactionConformance,
} from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { runPagePublishingConformance } from "@octant/provider-sdk/page-publishing-conformance";
import { Effect, PubSub, Queue, Stream } from "effect";
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
const signedInPageInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000726");
const signedOutPageInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000727");
const pageRequest = { fileName: "launch-plan.html", title: "Launch plan", html: "<p>Plan</p>" };
const refusedPageRequest = { fileName: "too-big.html", title: "Too big", html: "<p>Nope</p>" };
const publishedPageAddress = "https://claude.ai/artifact/conformance";

function conformanceDriver(
  makeQuery: (input: ClaudeOpenQueryInput, sdkSessionId: string) => ConformanceQuery = (
    input,
    sdkSessionId,
  ) => new ConformanceQuery(input, sdkSessionId),
  account: { readonly instanceId: ProviderInstanceId; readonly pagesReady: boolean } = {
    instanceId,
    pagesReady: false,
  },
) {
  const opened: ConformanceQuery[] = [];
  const histories = new Map<string, ClaudeSessionMetadata>();
  let runtimeNumber = 0;
  const sdk: ClaudeAgentSdkPort = {
    openQuery: (input) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const query = makeQuery(
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
        histories.get(sdkSessionId)?.projectRoot === root ? histories.get(sdkSessionId) : undefined,
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
  // Page publishing answers from the probe's observation, so the fixture's
  // signed-in account carries one that declares the capability; the
  // signed-out account has none, as an account the probe never saw ready.
  if (account.pagesReady) {
    registry.setObservedState({
      instanceId: account.instanceId,
      readiness: "ready",
      processState: "stopped",
      detectedVersion: "2.1.211",
      models: [],
      capabilities: {
        streaming: "supported",
        resume: "supported",
        interruption: "supported",
        approvals: "supported",
        userQuestions: "supported",
        reasoning: "supported",
        usage: "supported",
        toolActivity: "supported",
        fileChanges: "supported",
        diffs: "supported",
        taskProgress: "supported",
        nativeChildAgents: "unsupported",
        harnessAutoReview: "supported",
        nativeAttachments: "unsupported",
        nativeWebResearch: "unsupported",
        appManagedTools: "supported",
        citations: "unsupported",
        artifactPublish: "supported",
      },
      lastSuccessfulProbeAt: occurredAt,
      observedAt: occurredAt,
    });
  }
  const driver = makeClaudeDriver({
    instanceId: account.instanceId,
    displayName: "Claude",
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
  return { driver, opened };
}

describe("Claude provider conformance", () => {
  it("holds Claude to its session-compaction claim", async () => {
    const hold = Promise.withResolvers<void>();
    const { driver, opened } = conformanceDriver(
      (input, sdkSessionId) => new CompletingQuery(input, sdkSessionId, hold.promise),
    );
    await expect(
      runSessionCompactionConformance({
        driver,
        probeInput: { instanceId },
        acquireInput: { instanceId, projectRoot, mode: "code" },
        sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
        turns: [
          { sessionId, prompt: "remember the plan", attachments: [], tools: [] },
          { sessionId, prompt: "carry on", attachments: [], tools: [] },
        ],
        resume: (handle) => ({
          sessionId: handle.sessionId,
          resumeCursor: handle.resumeCursor ?? { driverKind: "claude", value: "missing" },
          executionPolicy: "approval-gated",
        }),
        compactionId: "80000000-0000-4000-8000-000000000725",
        releaseCompaction: () => hold.resolve(),
        isReleased: () => opened.length > 0 && opened.every((query) => query.closed),
      }),
    ).resolves.toEqual({
      claim: "supported",
      compacted: true,
      turnRefusedWhileCompacting: true,
      released: true,
    });
  });

  it("passes the real driver lifecycle, capabilities, resume, failure, and cleanup harness", async () => {
    const { driver, opened } = conformanceDriver();

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

  it("holds Claude to its page-publishing claim", async () => {
    // A Claude driver holds one account, so the suite's signed-in and
    // signed-out instances are two drivers; each answers through the seam for
    // its own instance and reports every other as absent.
    const signedIn = conformanceDriver(
      (input, sdkSessionId) => new PublishingQuery(input, sdkSessionId),
      { instanceId: signedInPageInstanceId, pagesReady: true },
    );
    const signedOut = conformanceDriver(
      (input, sdkSessionId) => new PublishingQuery(input, sdkSessionId),
      { instanceId: signedOutPageInstanceId, pagesReady: false },
    );
    const sourceFor = (requested: ProviderInstanceId) =>
      pagePublishingOf(
        String(requested) === String(signedOutPageInstanceId) ? signedOut.driver : signedIn.driver,
      );
    const source: ProviderPagePublishingSource = {
      availability: (input) => sourceFor(input.instanceId).availability(input),
      publish: (input) => sourceFor(input.instanceId).publish(input),
    };

    await expect(
      runPagePublishingConformance({
        source,
        signedInInstanceId: signedInPageInstanceId,
        signedOutInstanceId: signedOutPageInstanceId,
        request: pageRequest,
        refusedRequest: refusedPageRequest,
      }),
    ).resolves.toEqual({
      signedOutPublishesNothing: true,
      unknownInstanceAbsent: true,
      readyNamesAccount: true,
      publishedNamesAddress: true,
      refusalIsValue: true,
    });
    // Only the signed-in account ran a session, one per publish, and each closed.
    expect(signedOut.opened).toHaveLength(0);
    expect(signedIn.opened).toHaveLength(2);
    expect(signedIn.opened.every((query) => query.closed)).toBe(true);
  });
});

function pagePublishingOf(driver: ProviderDriver): ProviderPagePublishingSource {
  if (driver.pagePublishing === undefined) {
    throw new Error("The Claude driver offers no page publishing.");
  }
  return driver.pagePublishing;
}

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
    compactAnnounced: true,
  };
  readonly supportedModels = () => Effect.succeed(this.initialization.models);
  /** Released before `/compact` is answered; a subclass holds it open. */
  protected compactionHold: Promise<void> = Promise.resolve();
  /** `/compact` as the runtime answers it: the cut and its status. */
  readonly requestCompaction: ClaudeQueryPort["requestCompaction"] = () =>
    Effect.sync(() => {
      void this.answerCompaction();
    });

  private async answerCompaction(): Promise<void> {
    await this.compactionHold;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await this.emit({ kind: "status", sessionId: this.sdkSessionId, status: "compacting" });
    await this.emit({
      kind: "compaction",
      sessionId: this.sdkSessionId,
      trigger: "manual",
      preTokens: 48_000,
      postTokens: 6_000,
    });
    await this.emit({
      kind: "status",
      sessionId: this.sdkSessionId,
      status: null,
      compactResult: "success",
    });
  }
  readonly accountInfo = () => Effect.succeed(this.initialization.account);
  readonly readPlanUsage = () => Effect.succeed(undefined);
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
    // Claude Code consults the permission callback only for a hook "ask";
    // a hook "allow" runs the tool without it.
    const gate = await this.input.preToolUse(request);
    if (gate.behavior === "ask") {
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
    // Claude Code consults the permission callback only for a hook "ask";
    // a hook "allow" runs the tool without it.
    const gate = await this.input.preToolUse(request);
    if (gate.behavior === "ask") {
      void this.input.canUseTool({
        toolName: request.toolName,
        input,
        toolUseId: request.toolUseId,
        signal,
      });
    }
  }

  protected emit(message: ClaudeDecodedMessage): Promise<boolean> {
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

/**
 * A runtime asked to publish a page: it publishes the one file in its folder
 * with the Artifact tool, or fails that call when the file is the page the
 * fixture says the provider refuses.
 */
class PublishingQuery extends ConformanceQuery {
  // A queue, not the parent's pub-sub: the one-shot subscribes only after its
  // prompt is sent, and a pub-sub drops what it published before then.
  readonly #queue = Effect.runSync(Queue.unbounded<ClaudeDecodedMessage>());
  override readonly messages: Stream.Stream<ClaudeDecodedMessage, ProviderFailure> =
    Stream.fromQueue(this.#queue);

  override readonly send: ClaudeQueryPort["send"] = () =>
    Effect.promise(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const [fileName] = readdirSync(this.input.projectRoot);
      const refusedPage = fileName === refusedPageRequest.fileName;
      const offer = (message: ClaudeDecodedMessage) =>
        Effect.runPromise(Queue.offer(this.#queue, message));
      await offer({
        kind: "assistant",
        sessionId: this.sdkSessionId,
        messageId: "message-1",
        content: [
          {
            kind: "tool-use",
            toolUseId: "publish-1",
            toolName: "Artifact",
            input: { file_path: `${this.input.projectRoot}/${fileName ?? ""}` },
          },
        ],
        usage: usage(),
      });
      await offer({
        kind: "tool-results",
        sessionId: this.sdkSessionId,
        results: [
          refusedPage
            ? { toolUseId: "publish-1", isError: true }
            : { toolUseId: "publish-1", isError: false, artifactUrl: publishedPageAddress },
        ],
      });
      await offer({
        kind: "result",
        sessionId: this.sdkSessionId,
        outcome: "success",
        subtype: "success",
        stopReason: "end_turn",
        usage: usage(),
        permissionDenials: [],
      });
    });
}

/**
 * A runtime whose turns finish with a reply, so there is a session to compact,
 * and whose compaction is held open until the harness releases it.
 */
class CompletingQuery extends ConformanceQuery {
  constructor(input: ClaudeOpenQueryInput, sdkSessionId: string, hold: Promise<void>) {
    super(input, sdkSessionId);
    this.compactionHold = hold;
  }

  override readonly send: ClaudeQueryPort["send"] = () =>
    Effect.promise(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await this.emit({
        kind: "stream-event",
        sessionId: this.sdkSessionId,
        event: { kind: "text-delta", index: 0, text: "noted" },
      });
      await this.emit({
        kind: "result",
        sessionId: this.sdkSessionId,
        outcome: "success",
        subtype: "success",
        stopReason: "end_turn",
        usage: usage(),
        permissionDenials: [],
      });
    });
}
