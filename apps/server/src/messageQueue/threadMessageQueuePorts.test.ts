import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  decodeChatThread,
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceReference,
  decodeCodeOperationResult,
  decodeCodeOperationId,
  decodeCodeThread,
  EventEnvelope,
  decodeMentionableThreadId,
  decodeProject,
  decodeProviderInstance,
  decodeProviderModelId,
  decodeStartWorkThreadTurnCommand,
  decodeThreadQueueMessageId,
  decodeWindowId,
  decodeWorkThread,
  decodeWorkTurnState,
  type WorkTurnState,
} from "@octant/contracts";
import {
  createThreadMessageQueuePort,
  type ThreadMessageQueuePortDependencies,
} from "./threadMessageQueuePorts";

const threadId = decodeMentionableThreadId("92000000-0000-4000-8000-000000000001");
const windowId = decodeWindowId("92000000-0000-4000-8000-000000000002");
const thread = decodeChatThread({
  id: threadId,
  title: "Queued conversation",
  lifecycle: "active",
  providerInstanceId: "92000000-0000-4000-8000-000000000003",
  modelId: "model-a",
  researchEnabled: false,
  researchRouting: "automatic",
  personalityInstructions: "Be helpful.",
  version: 1,
  createdAt: "2026-10-03T12:00:00.000Z",
  updatedAt: "2026-10-03T12:00:00.000Z",
});

function setup() {
  let current = thread;
  const deps: ThreadMessageQueuePortDependencies = {
    persistence: {
      readChatThread: () => current,
      readChatThreadView: () => undefined,
      readCodeThread: () => undefined,
      readCodeRuntimeWorks: () => [],
      readCodeCheckout: () => undefined,
      readProject: () => undefined,
      readProviderInstance: () => undefined,
    },
    journal: { replayAggregate: () => [] },
    chat: { execute: vi.fn(async () => undefined) },
    work: { readThread: () => undefined, listTurns: () => [], startFirstTurn: vi.fn() },
    code: {},
    isModeEnabled: () => true,
    isWindowLive: () => true,
    canAccess: () => true,
    attachments: {
      retain: () => ({ status: "retained" }),
      commit: () => undefined,
      release: async () => ({ status: "released" }),
      prepare: async () => true,
    },
  };
  return {
    deps,
    changeModel: () => {
      current = { ...current, modelId: decodeProviderModelId("model-b") };
    },
  };
}

describe("queued turn admission", () => {
  it.each(["work", "code"] as const)(
    "starts queued %s messages through ordinary admission with the recorded identity",
    async (mode) => {
      const { deps } = setup();
      const now = thread.createdAt;
      const projectId = "92000000-0000-4000-8000-000000000010";
      const bindingRevisionId = "92000000-0000-4000-8000-000000000011";
      const checkoutId = "92000000-0000-4000-8000-000000000012";
      const repositoryId = `repo_${"b".repeat(64)}`;
      const binding = { canonicalRoot: "/workspace/project" };
      const project = decodeProject({
        id: projectId,
        name: "Project",
        type: mode,
        lifecycle: "active",
        pinned: false,
        rank: "0/1",
        version: 1,
        createdAt: now,
        updatedAt: now,
        binding,
        bindingHistory: [
          {
            revisionId: bindingRevisionId,
            revision: 1,
            currentBinding: binding,
            actor: { kind: "local-user", actorId: windowId },
            changedAt: now,
          },
        ],
        ...(mode === "code" ? { codeAccessPersistence: "current-session" } : {}),
      });
      const fields = {
        id: threadId,
        projectId,
        bindingRevisionId,
        title: "Queued work",
        lifecycle: "active",
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      const workThread = decodeWorkThread({ ...fields, workingDirectory: "docs" });
      let workTurns: ReadonlyArray<WorkTurnState> = [];
      const replay = vi.fn<ThreadMessageQueuePortDependencies["journal"]["replayAggregate"]>(
        () => [],
      );
      const codeThread = decodeCodeThread({
        ...fields,
        checkoutId,
        repositoryId,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: "feature/queued-work",
          remoteName: "origin",
          proposedBaseRepository: "octant/octant",
          proposedBaseBranch: "main",
          outcomeKind: "local-implementation",
          confirmedAt: now,
        },
      });
      const startFirstTurn = vi.fn<ThreadMessageQueuePortDependencies["work"]["startFirstTurn"]>(
        async (_window, raw) => {
          const command = decodeStartWorkThreadTurnCommand(raw);
          return {
            kind: "accepted",
            turn: decodeWorkTurnState({
              requestId: command.requestId,
              threadId: command.threadId,
              turnId: command.turnId,
              projectId,
              authority: command.authority,
              prompt: command.prompt,
              status: "accepted",
              transcript: [],
              capabilities: {
                workspace: "project-backed",
                confinement: "project-root-confined",
                shell: "denied",
                git: "denied",
                worktree: "denied",
                pullRequest: "denied",
                code: "denied",
              },
              version: 1,
              acceptedAt: now,
              updatedAt: now,
            }),
          };
        },
      );
      const executeOperation = vi.fn<
        NonNullable<ThreadMessageQueuePortDependencies["code"]["executeOperation"]>
      >(async (_window, command) =>
        decodeCodeOperationResult({
          kind: "provider-turn-state",
          operationId: command.operationId,
          state: "running",
        }),
      );
      const port = createThreadMessageQueuePort({
        ...deps,
        journal: { replayAggregate: replay },
        persistence: {
          ...deps.persistence,
          readProject: () => project,
          readCodeThread: () => codeThread,
          readCodeCheckout: () =>
            decodeCodeCheckoutIdentity({
              id: checkoutId,
              repositoryId,
              kind: "plain-folder",
              availability: "available",
              head: { kind: "none" },
              observedAt: now,
            }),
        },
        work: {
          ...deps.work,
          readThread: () => workThread,
          listTurns: () => workTurns,
          startFirstTurn,
        },
        code: {
          executeOperation,
          stageEvidence: () =>
            decodeCodeEvidenceReference({
              contentId: checkoutId,
              digest: "a".repeat(64),
              byteLength: 8,
            }),
        },
      });
      const scope = { mode, threadId };
      const messageId = decodeThreadQueueMessageId("92000000-0000-4000-8000-000000000004");
      const codeOperationId = decodeCodeOperationId("92000000-0000-4000-8000-000000000005");
      const inspection = await port.inspect({ scope, windowId, intent: "enqueue" });
      if (inspection.status === "held") throw new Error("Expected an admitted scope.");
      expect(
        await port.admit({
          scope,
          windowId,
          messageId,
          ...(mode === "code" ? { codeOperationId } : {}),
          binding: inspection.binding,
          payload: { mode, prompt: "Continue", threadMentionIds: [threadId] },
          signal: new AbortController().signal,
        }),
      ).toEqual({ status: "accepted" });
      if (mode === "work") {
        expect(startFirstTurn).toHaveBeenCalledWith(
          windowId,
          expect.objectContaining({
            requestId: messageId,
            turnId: messageId,
            authority: expect.objectContaining({
              confinementPosture: "project-root-confined",
              workingDirectory: "docs",
            }),
          }),
          expect.objectContaining({ admissionCurrent: expect.any(Function) }),
        );
        const accepted = await startFirstTurn.mock.results[0]?.value;
        if (accepted?.kind !== "accepted") throw new Error("Expected Work admission.");
        const guard = startFirstTurn.mock.calls[0]?.[2]?.admissionCurrent;
        workTurns = [accepted.turn];
        expect(guard?.()).toBe(true);
        workTurns = [decodeWorkTurnState({ ...accepted.turn, status: "cancelled" })];
        expect(guard?.()).toBe(false);
        workTurns = [
          decodeWorkTurnState({ ...accepted.turn, turnId: "92000000-0000-4000-8000-000000000099" }),
        ];
        expect(guard?.()).toBe(false);
        workTurns = workTurns.map((turn) => decodeWorkTurnState({ ...turn, status: "cancelled" }));
        expect(guard?.()).toBe(false);
      } else {
        expect(executeOperation).toHaveBeenCalledWith(
          windowId,
          expect.objectContaining({
            operationId: codeOperationId,
            sessionId: codeOperationId,
            checkoutId,
            threadMentionIds: [threadId],
          }),
          expect.objectContaining({ admissionCurrent: expect.any(Function) }),
        );
        const event = (sequence: number, payload: unknown) =>
          Schema.decodeUnknownSync(EventEnvelope)({
            eventId: messageId,
            globalSequence: sequence,
            aggregateType: "code-operation",
            aggregateId: codeOperationId,
            aggregateVersion: sequence,
            eventName: "code.operation-event-recorded@1",
            eventVersion: 1,
            hostId: "local",
            correlationId: messageId,
            actor: { kind: "local-user", actorId: windowId },
            occurredAt: now,
            payload: {
              threadId,
              operationId: codeOperationId,
              cursor: sequence,
              occurredAt: now,
              event: payload,
            },
          });
        const started = event(1, {
          kind: "conversation-turn-started",
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
          sessionId: codeOperationId,
          prompt: { contentId: checkoutId, digest: "a".repeat(64), byteLength: 8 },
        });
        replay.mockReturnValue([started]);
        expect(await port.reconcile({ scope, messageId, codeOperationId })).toEqual({
          status: "unknown",
        });
        replay.mockReturnValue([
          started,
          event(2, {
            kind: "operation-result",
            result: {
              kind: "provider-turn-state",
              operationId: codeOperationId,
              state: "failed",
            },
          }),
        ]);
        expect(await port.reconcile({ scope, messageId, codeOperationId })).toEqual({
          status: "failed",
        });
        for (const kind of ["provider-turn-state", "operation-failed"]) {
          replay.mockReturnValue([
            started,
            event(2, {
              kind: "operation-result",
              result: {
                kind,
                operationId: codeOperationId,
                ...(kind === "provider-turn-state" ? { state: "failed" } : {}),
                admission: "refused",
                failure: { category: "unauthorized", message: "Admission was revoked." },
              },
            }),
          ]);
          expect(await port.reconcile({ scope, messageId, codeOperationId })).toEqual({
            status: "not-admitted",
          });
        }
        replay.mockReturnValue([
          started,
          event(2, {
            kind: "operation-result",
            result: {
              kind: "operation-failed",
              operationId: codeOperationId,
              failure: { category: "unavailable", message: "Provider preparation failed." },
            },
          }),
        ]);
        expect(await port.reconcile({ scope, messageId, codeOperationId })).toEqual({
          status: "failed",
        });
        expect(replay).toHaveBeenLastCalledWith(
          expect.objectContaining({ aggregateId: codeOperationId }),
        );
      }
    },
  );

  it("acknowledges a journaled Chat send before the reply finishes and preserves submission identity", async () => {
    const { deps } = setup();
    const execute: ThreadMessageQueuePortDependencies["chat"]["execute"] = vi.fn(
      (_command, context) => {
        context?.onTurnAccepted?.();
        return new Promise(() => undefined);
      },
    );
    const port = createThreadMessageQueuePort({ ...deps, chat: { execute } });
    const scope = { mode: "chat", threadId } as const;
    const inspection = await port.inspect({ scope, windowId, intent: "enqueue" });
    if (inspection.status === "held") throw new Error("Expected an admitted scope.");
    const messageId = decodeThreadQueueMessageId("92000000-0000-4000-8000-000000000004");
    expect(
      await port.admit({
        scope,
        windowId,
        messageId,
        binding: inspection.binding,
        payload: {
          mode: "chat",
          prompt: "Continue with the next part.",
          threadMentionIds: [threadId],
        },
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "accepted" });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "send-chat-turn",
        submissionId: messageId,
        prompt: "Continue with the next part.",
        threadMentionIds: [threadId],
        expectedVersion: thread.version,
      }),
      expect.objectContaining({ windowId }),
    );
  });

  it("rechecks a revoked grant after reading queued attachments", async () => {
    const { deps } = setup();
    let live = true;
    const execute = vi.fn(deps.chat.execute);
    const port = createThreadMessageQueuePort({
      ...deps,
      chat: { execute },
      isWindowLive: () => live,
      attachments: {
        ...deps.attachments,
        prepare: async () => {
          live = false;
          return true;
        },
      },
    });
    const scope = { mode: "chat", threadId } as const;
    const inspection = await port.inspect({ scope, windowId, intent: "enqueue" });
    if (inspection.status === "held") throw new Error("Expected an admitted scope.");
    expect(
      await port.admit({
        scope,
        windowId,
        messageId: decodeThreadQueueMessageId("92000000-0000-4000-8000-000000000004"),
        binding: inspection.binding,
        payload: { mode: "chat", prompt: "Keep going." },
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "refused", reason: "authority-revoked" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("requires the original live window and refuses a disabled mode", async () => {
    const { deps } = setup();
    const input = { scope: { mode: "chat", threadId }, windowId, intent: "enqueue" } as const;
    expect(
      await createThreadMessageQueuePort({ ...deps, isWindowLive: () => false }).inspect(input),
    ).toEqual({ status: "held", reason: "authority-revoked" });
    expect(
      await createThreadMessageQueuePort({ ...deps, isModeEnabled: () => false }).inspect(input),
    ).toEqual({ status: "held", reason: "thread-unavailable" });
  });

  it("keeps an unavailable thread's reason when admission is refused", async () => {
    const { deps } = setup();
    const port = createThreadMessageQueuePort({ ...deps, isModeEnabled: () => false });
    expect(
      await port.admit({
        scope: { mode: "chat", threadId },
        windowId,
        messageId: decodeThreadQueueMessageId("92000000-0000-4000-8000-000000000004"),
        binding: "previous binding",
        payload: { mode: "chat", prompt: "Continue." },
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "refused", reason: "thread-unavailable" });
  });

  it("changes the admission binding when the selected model changes", async () => {
    const { deps, changeModel } = setup();
    const port = createThreadMessageQueuePort(deps);
    const input = { scope: { mode: "chat", threadId }, windowId, intent: "read" } as const;
    const before = await port.inspect(input);
    changeModel();
    const after = await port.inspect(input);
    expect(before.status).toBe("ready");
    expect(after.status).toBe("ready");
    if (before.status !== "held" && after.status !== "held")
      expect(after.binding).not.toBe(before.binding);
  });
  it("keeps a binding across provider renames while detecting configuration changes", async () => {
    const { deps } = setup();
    let provider = decodeProviderInstance({
      id: thread.providerInstanceId,
      displayName: "My provider",
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/agent" },
    });
    const port = createThreadMessageQueuePort({
      ...deps,
      persistence: { ...deps.persistence, readProviderInstance: () => provider },
    });
    const input = { scope: { mode: "chat", threadId }, windowId, intent: "read" } as const;
    const before = await port.inspect(input);
    provider = decodeProviderInstance({ ...provider, displayName: "Renamed", version: 2 });
    expect(await port.inspect(input)).toEqual(before);
    provider = decodeProviderInstance({ ...provider, enabled: false, version: 3 });
    expect(await port.inspect(input)).not.toEqual(before);
  });
});
