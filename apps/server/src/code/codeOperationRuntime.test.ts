import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorId,
  CodeOperationEventFrame,
  CodeRuntimeWorkUpdated,
  MAX_CODE_OPERATION_TEXT_BYTES,
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceReference,
  decodeCodeOperationId,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProviderSessionId,
  type CodeOperationEventFrame as OperationFrame,
  type CodeRuntimeWork,
  type CodeThread,
  type ProviderRuntimeEvent,
  type WindowId,
} from "@octant/contracts";
import { Effect, Queue, Stream } from "effect";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { CodeProjection, readCodeRuntimeWorks } from "../persistence/codeProjection";
import { CODE_OPERATION_EVENT_RECORDED } from "./codeOperationEventStore";
import { createCodeOperationRuntime } from "./codeOperationRuntime";
import { CODE_RUNTIME_WORK_UPDATED } from "./codeRuntimeWorkRecorder";
import { boardRuntimeActivityFromWorks } from "./codeThreadBoardService";
import { CodeEvidenceCapacityExceeded } from "./codeEvidenceStore";
import type {
  GitObservationPort,
  GitObservationResult,
  GitScopedDiffResult,
} from "./gitObservationPort";

const now = "2026-07-21T13:00:00.000Z";
const windowId = "90000000-0000-4000-8000-000000000001" as WindowId;
const threadId = decodeCodeThreadId("90000000-0000-4000-8000-000000000002");
const checkoutId = decodeCodeCheckoutId("90000000-0000-4000-8000-000000000003");
const sessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000004");
const actor = {
  kind: "system" as const,
  actorId: Effect.runSync(
    Effect.try(
      () =>
        // The runtime validates this through the journal contract.
        "90000000-0000-4000-8000-000000000005" as typeof ActorId.Type,
    ),
  ),
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("CodeOperationRuntime", () => {
  it("prepares and confirms native approval only for the authoritative active scope", async () => {
    const fixture = runtimeFixture({ approvalValidator: false });
    const request = {
      effect: {
        kind: "operation" as const,
        command: {
          kind: "start-terminal" as const,
          threadId,
          checkoutId,
          operationId: operationId(1),
          terminalId: operationId(2) as never,
          columns: 100,
          rows: 30,
          credentialRefs: [],
        },
      },
    };
    const challenge = await fixture.runtime.prepareApproval(windowId, request);
    expect(challenge).toMatchObject({
      challengeId: expect.any(String),
      contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      projectId: thread().projectId,
      threadId,
      checkoutId,
      repositoryId: thread().repositoryId,
      checkoutHead: { kind: "branch", name: "feature/runtime", oid: "a".repeat(40) },
      message: "Allow terminal access?",
    });
    expect(challenge?.detail).toContain(`Thread: ${thread().title} (${threadId})`);
    await expect(
      fixture.runtime.confirmApproval(windowId, { challengeId: challenge!.challengeId }),
    ).resolves.toMatchObject({ approvalId: expect.any(String) });
    fixture.access.mockResolvedValueOnce(false);
    await expect(fixture.runtime.prepareApproval(windowId, request)).resolves.toBeUndefined();
    await expect(
      fixture.runtime.prepareApproval(windowId, {
        effect: {
          ...request.effect,
          command: { ...request.effect.command, checkoutId: operationId(999) as never },
        },
      }),
    ).resolves.toBeUndefined();
    fixture.close();
  });

  it("does not record runtime work for a command outside the window's Project scope", async () => {
    const fixture = runtimeFixture({ approvalValidator: false });
    fixture.access.mockResolvedValue(false);

    const result = await fixture.runtime.execute(windowId, {
      kind: "start-terminal",
      operationId: operationId(3),
      threadId,
      checkoutId,
      terminalId: operationId(4) as never,
      columns: 100,
      rows: 30,
      credentialRefs: [],
    });

    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: { category: "unauthorized" },
    });
    expect(fixture.runtimeWorks()).toEqual([]);
    fixture.close();
  });

  it("prepares and consumes one-shot approval for the exact core Apple action", async () => {
    const fixture = runtimeFixture({ approvalValidator: false });
    const request = {
      actionId: operationId(800) as never,
      correlationId: operationId(801) as never,
      authority: {
        hostId: "90000000-0000-4000-8000-000000000010" as never,
        mode: "code" as const,
        projectId: thread().projectId,
        providerInstanceId: thread().providerInstanceId,
        extension: { kind: "core" as const },
      },
      threadId,
      checkoutId,
      kind: "build" as const,
      platform: "ios" as const,
      scheme: "Fixture",
      simulatorId: "90000000-0000-4000-8000-000000000011" as never,
      projectPath: "Fixture.xcodeproj",
      timeoutMs: 120_000,
      approval: { kind: "pending" as const },
    };
    const challenge = await fixture.runtime.prepareApproval(windowId, {
      effect: { kind: "apple-action", request },
    });
    expect(challenge).toMatchObject({
      message: "Allow Apple build?",
      threadId,
      checkoutId,
    });
    const receipt = await fixture.runtime.confirmApproval(windowId, {
      challengeId: challenge!.challengeId,
    });
    const validate = (
      fixture.runtime as unknown as {
        validateAppleApproval: (windowId: WindowId, request: unknown) => Promise<boolean>;
      }
    ).validateAppleApproval;
    expect(validate).toBeTypeOf("function");
    const approved = {
      ...request,
      approval: { kind: "approved" as const, approvalId: receipt!.approvalId },
    };
    await expect(validate.call(fixture.runtime, windowId, approved)).resolves.toBe(true);
    await expect(validate.call(fixture.runtime, windowId, approved)).resolves.toBe(false);
    fixture.close();
  });

  it("bounds oversized approval display details while preserving challenge creation", async () => {
    const fixture = runtimeFixture({ approvalValidator: false });
    const challenge = await fixture.runtime.prepareApproval(windowId, {
      effect: {
        kind: "operation",
        command: {
          kind: "stage-git",
          threadId,
          checkoutId,
          operationId: operationId(3),
          gitOperationId: operationId(4) as never,
          paths: Array.from(
            { length: 1_000 },
            (_, index) => `src/${index.toString().padStart(4, "0")}-${"x".repeat(100)}`,
          ) as never,
          expectedStateToken: "b".repeat(64),
        },
      },
    });

    expect(challenge).toBeDefined();
    expect(new TextEncoder().encode(challenge!.detail).byteLength).toBeLessThanOrEqual(
      MAX_CODE_OPERATION_TEXT_BYTES + 4_096,
    );
    expect(challenge!.detail).toContain("Additional approval detail omitted");
    fixture.close();
  });

  // Code starts approval-gated, and the renderer awaits an approval before
  // sending either command. A missing prompt is not a cosmetic gap: it throws,
  // so Unstage and Restore never reach the service in the default posture.
  it("prompts for the Git operations that leave the index or overwrite the tree", async () => {
    const fixture = runtimeFixture({ approvalValidator: false });

    const unstage = await fixture.runtime.prepareApproval(windowId, {
      effect: {
        kind: "operation",
        command: {
          kind: "unstage-git",
          threadId,
          checkoutId,
          operationId: operationId(3),
          gitOperationId: operationId(4) as never,
          paths: ["src/main.ts"] as never,
          expectedStateToken: "b".repeat(64),
        },
      },
    });
    const restore = await fixture.runtime.prepareApproval(windowId, {
      effect: {
        kind: "operation",
        command: {
          kind: "restore-git-checkpoint",
          threadId,
          checkoutId,
          operationId: operationId(5),
          gitOperationId: operationId(6) as never,
          checkpoint: { worktree: "c".repeat(40), index: "d".repeat(40) } as never,
        },
      },
    });

    const discard = await fixture.runtime.prepareApproval(windowId, {
      effect: {
        kind: "operation",
        command: {
          kind: "discard-git-changes",
          threadId,
          checkoutId,
          operationId: operationId(7),
          gitOperationId: operationId(8) as never,
          paths: ["src/main.ts"] as never,
          expectedStateToken: "b".repeat(64),
        },
      },
    });

    expect(discard?.message).toBe("Discard uncommitted changes?");
    expect(unstage?.message).toBe("Allow Code unstage operation?");
    expect(unstage?.detail).toContain("src/main.ts");
    expect(restore?.message).toBe("Restore the checkout to this checkpoint?");
    // The prompt has to name the loss, not only the point restored to.
    expect(restore?.detail).toContain(
      "Uncommitted work not saved in this checkpoint is overwritten.",
    );
    fixture.close();
  });

  it("runs a provider turn asynchronously and owns exact input, approval, and cancellation", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
    });
    const startOperation = operationId(10);

    const started = await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });

    expect(started).toMatchObject({ kind: "provider-turn-state", state: "running" });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    await expect(
      fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: startOperation,
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    expect(connection.send).toHaveBeenCalledOnce();
    await Effect.runPromise(
      Queue.offer(
        queue,
        providerEvent({
          kind: "approval-request",
          requestId: "provider-approval-1",
          action: "write",
          description: "Modify src/a.ts",
        }),
      ),
    );
    await Effect.runPromise(
      Queue.offer(
        queue,
        providerEvent({
          kind: "user-input-request",
          requestId: "question-1",
          prompt: "Choose one",
          options: ["A", "B"],
        }),
      ),
    );

    let frames: readonly OperationFrame[] = [];
    await vi.waitFor(async () => {
      frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20);
      expect(frames.some((frame) => frame.event.kind === "approval-requested")).toBe(true);
      expect(frames.some((frame) => frame.event.kind === "input-requested")).toBe(true);
    });
    fixture.setThread(
      decodeCodeThread({
        ...thread(),
        providerInstanceId: "90000000-0000-4000-8000-000000000010",
        modelId: "model-b",
        version: 2,
        providerHandoff: {
          previousProviderInstanceId: thread().providerInstanceId,
          previousModelId: thread().modelId,
          nextProviderInstanceId: "90000000-0000-4000-8000-000000000010",
          nextModelId: "model-b",
          changedAt: now,
        },
      }),
    );
    const approval = frames.find(
      (
        frame,
      ): frame is OperationFrame & { event: { kind: "approval-requested"; approvalId: string } } =>
        frame.event.kind === "approval-requested",
    );
    expect(approval).toBeDefined();

    await fixture.runtime.execute(windowId, {
      kind: "answer-provider-input",
      operationId: operationId(11),
      threadId,
      checkoutId,
      requestId: "question-1",
      response: fixture.response,
    });
    await fixture.runtime.execute(windowId, {
      kind: "answer-provider-approval",
      operationId: operationId(12),
      threadId,
      checkoutId,
      approvalId: approval!.event.approvalId,
      decision: "approved",
    });
    await fixture.runtime.execute(windowId, {
      kind: "cancel-provider-turn",
      operationId: operationId(13),
      threadId,
      checkoutId,
    });

    expect(connection.answerUserInput).toHaveBeenCalledWith({
      sessionId,
      requestId: "question-1",
      answer: "A",
    });
    expect(connection.answerApproval).toHaveBeenCalledWith({
      sessionId,
      requestId: "provider-approval-1",
      approved: true,
    });
    expect(connection.interrupt).toHaveBeenCalledWith(sessionId);
    await fixture.runtime.close();
    expect(connection.stop).toHaveBeenCalledWith(sessionId);
    fixture.close();
  });

  it("answers an approval requested by a narrowed turn on a broader thread", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
    });
    fixture.setThread(decodeCodeThread({ ...thread(), executionPolicy: "full-access" }));
    const startOperation = operationId(14);

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: startOperation,
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
        executionPolicy: "approval-gated",
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    await Effect.runPromise(
      Queue.offer(
        queue,
        providerEvent({
          kind: "approval-request",
          requestId: "provider-approval-narrowed",
          action: "write",
          description: "Modify src/a.ts",
        }),
      ),
    );

    let frames: readonly OperationFrame[] = [];
    await vi.waitFor(async () => {
      frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20);
      expect(frames.some((frame) => frame.event.kind === "approval-requested")).toBe(true);
    });
    const approval = frames.find(
      (
        frame,
      ): frame is OperationFrame & { event: { kind: "approval-requested"; approvalId: string } } =>
        frame.event.kind === "approval-requested",
    );
    expect(approval).toBeDefined();
    if (approval === undefined) return;

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "answer-provider-approval",
        operationId: operationId(15),
        threadId,
        checkoutId,
        approvalId: approval.event.approvalId,
        decision: "approved",
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    expect(connection.answerApproval).toHaveBeenCalledWith({
      sessionId,
      requestId: "provider-approval-narrowed",
      approved: true,
    });
    fixture.close();
  });

  it("reports a thread as executing for exactly as long as its provider turn runs", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
    });
    expect(fixture.boardActivity()).toMatchObject({ executing: false });

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(30),
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    expect(fixture.boardActivity()).toMatchObject({ executing: true, awaitingInput: false });

    await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));
    await vi.waitFor(() =>
      expect(fixture.boardActivity()).toMatchObject({
        executing: false,
        awaitingInput: false,
        interrupted: false,
      }),
    );
    fixture.close();
  });

  it("sanitizes provider claims before durable frames and authorizes subscriptions", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      credential: "secret",
      credentialReferences: [{ environmentName: "TOKEN", reference: "token" }],
    });
    const startOperation = operationId(20);
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    await Effect.runPromise(
      Queue.offer(
        queue,
        providerEvent({
          kind: "file-change",
          path: "/private/exact/src/a.ts",
          change: "modified",
        }),
      ),
    );
    await Effect.runPromise(
      Queue.offer(queue, providerEvent({ kind: "diff", diff: "+TOKEN=secret" })),
    );

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20);
      const serialized = JSON.stringify(frames);
      expect(serialized).toContain("src/a.ts");
      expect(serialized).not.toContain("/private/exact");
      expect(serialized).not.toContain("secret");
      expect([...fixture.evidenceValues.values()].join("\n")).not.toContain("secret");
    });
    fixture.access.mockResolvedValueOnce(false);
    await expect(
      fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20),
    ).rejects.toMatchObject({ category: "unauthorized" });
    fixture.close();
  });

  it("persists a failed turn outcome when durable evidence capacity rejects a provider chunk", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      evidencePut: () => {
        throw new CodeEvidenceCapacityExceeded();
      },
    });
    const startOperation = operationId(29);
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    await Effect.runPromise(
      Queue.offer(queue, providerEvent({ kind: "text-delta", text: "provider reply" })),
    );

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20);
      expect(frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: {
              kind: "operation-state",
              state: "failed",
              failure: {
                category: "unavailable",
                message:
                  "Local Code evidence storage is full. Back up this Octant profile and clear its local application data before retrying.",
              },
            },
          }),
        ]),
      );
    });
    fixture.close();
  });

  it("journals a provider failure sentence that arrived padded with whitespace", async () => {
    // `CodeOperationFailure` requires a trimmed, non-empty message, and
    // providers routinely end their last line with a newline. Forwarding the
    // raw text made the whole `operation-state` frame invalid, so the reason
    // the turn failed never reached the journal.
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({ provider: providerDriver(connection) });
    const startOperation = operationId(44);
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    await Effect.runPromise(
      Queue.offer(
        queue,
        providerEvent({
          kind: "failed",
          failure: { category: "provider-failed", message: "  Provider process died.\n" },
        }),
      ),
    );

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20);
      expect(frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: {
              kind: "operation-state",
              state: "failed",
              failure: { category: "failed", message: "Provider process died." },
            },
          }),
        ]),
      );
    });
    fixture.close();
  });

  it("fails closed when provider, credential, or gh executable authority is missing", async () => {
    const missingProvider = runtimeFixture({ provider: undefined });
    await expect(
      missingProvider.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(30),
        threadId,
        checkoutId,
        sessionId,
        prompt: missingProvider.prompt,
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "failed" });
    missingProvider.close();

    const missingCredential = runtimeFixture({
      provider: providerDriver(providerConnection(Effect.runSync(Queue.unbounded()))),
      credential: undefined,
      credentialReferences: [{ environmentName: "TOKEN", reference: "missing" }],
    });
    await expect(
      missingCredential.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(31),
        threadId,
        checkoutId,
        sessionId,
        prompt: missingCredential.prompt,
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "failed" });
    missingCredential.close();
  });

  it("drafts a commit from the index and a pull request from what the branch committed", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    // The drafting session is minted per request, so the answer has to be given
    // against whatever session the host actually opened.
    const connection = providerConnection(queue);
    const answering: ProviderConnection = {
      ...connection,
      send: (input) =>
        Effect.sync(() => {
          const base = {
            instanceId: thread().providerInstanceId,
            sessionId: input.sessionId,
            correlationId: operationId(900) as never,
            occurredAt: now,
          };
          Effect.runSync(
            Queue.offerAll(queue, [
              { ...base, sequence: 1, kind: "text-delta", text: "Tidy the loader\n\nWhy." },
              { ...base, sequence: 2, kind: "completed" },
            ] as unknown as ReadonlyArray<ProviderRuntimeEvent>),
          );
        }),
    };
    const asked: unknown[] = [];
    const fixture = runtimeFixture({
      provider: providerDriver(answering),
      // A branch whose work is already committed: the working tree is clean, so
      // the diff the pane shows is empty and describes neither draft.
      gitObservation: {
        status: "ready",
        checkoutRoot: "/private/exact",
        head: { kind: "branch", name: "feature/runtime", oid: "a".repeat(40) },
        statusEntries: [],
        changedPaths: [],
        insertions: 0,
        deletions: 0,
        stagedSummary: [{ path: "src/staged.ts", index: "M", worktree: " " }],
        diff: { text: "", byteLength: 0, truncated: false },
        remotes: [],
        upstream: { remote: "origin", mergeRef: "refs/heads/feature/runtime" },
        worktrees: [],
        stateToken: "b".repeat(64),
      },
      gitReadDiff: async (input) => {
        asked.push(input.scope);
        return {
          status: "ready",
          paths: ["src/staged.ts"],
          diff: { text: "+scoped", byteLength: 7, truncated: false },
        };
      },
    });

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "draft-git-text",
        operationId: operationId(33),
        threadId,
        checkoutId,
        purpose: "commit-message",
      }),
    ).resolves.toMatchObject({ kind: "git-draft-state", state: "completed" });

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "draft-git-text",
        operationId: operationId(34),
        threadId,
        checkoutId,
        purpose: "pull-request",
      }),
    ).resolves.toMatchObject({ kind: "git-draft-state", state: "completed" });

    // A commit describes the index, so unstaged work cannot leak into its
    // message. A pull request describes what the branch changed since it left
    // its base, which is why a clean checkout still has something to say.
    expect(asked).toEqual([{ kind: "staged" }, { kind: "branch", baseRef: "origin/development" }]);
    fixture.close();
  });

  it("normalizes scp remotes and preserves worktree and truncation evidence", async () => {
    const fixture = runtimeFixture({
      gitObservation: {
        status: "ready",
        checkoutRoot: "/private/exact",
        head: { kind: "branch", name: "feature/runtime", oid: "a".repeat(40) },
        statusEntries: [{ path: "src/a.ts", index: " ", worktree: "M" }],
        changedPaths: ["src/a.ts"],
        insertions: 1,
        deletions: 0,
        stagedSummary: [],
        diff: { text: "+changed", byteLength: 8, truncated: true },
        remotes: [
          {
            name: "origin",
            fetchUrl: "git@github.com:octant/octant.git",
            pushUrl: "git@github.com:octant/octant.git",
          },
        ],
        upstream: { remote: "origin", mergeRef: "refs/heads/feature/runtime" },
        worktrees: [
          {
            path: "/private/exact",
            head: "a".repeat(40),
            branch: "refs/heads/feature/runtime",
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
          },
        ],
        stateToken: "b".repeat(64),
      },
    });

    const result = await fixture.runtime.execute(windowId, {
      kind: "observe-git",
      operationId: operationId(31),
      threadId,
      checkoutId,
      gitOperationId: operationId(32),
      maxDiffBytes: 1_024,
    });

    expect(result).toMatchObject({
      kind: "git-observed",
      insertions: 1,
      deletions: 0,
      diff: { truncated: true },
      remotes: [
        {
          fetch: { kind: "network", url: "ssh://git@github.com/octant/octant.git" },
          push: { kind: "network", url: "ssh://git@github.com/octant/octant.git" },
        },
      ],
      worktrees: [
        {
          head: { kind: "branch", name: "feature/runtime", oid: "a".repeat(40) },
          state: "active",
        },
      ],
    });
    if (result.kind !== "git-observed") throw new Error("Expected Git evidence.");
    const readEvidenceBatch = fixture.runtime.readEvidenceBatch;
    if (readEvidenceBatch === undefined) throw new Error("Expected batch evidence reads.");
    await expect(
      fixture.runtime.readEvidence(windowId, threadId, operationId(31), result.diff.contentId),
    ).resolves.toMatchObject({
      bytes: new TextEncoder().encode("+changed"),
      digest: result.diff.digest,
      byteLength: 8,
    });

    fixture.access.mockResolvedValueOnce(false);
    await expect(
      fixture.runtime.readEvidence(windowId, threadId, operationId(31), result.diff.contentId),
    ).rejects.toMatchObject({ failure: { category: "unauthorized" } });

    fixture.access.mockResolvedValueOnce(false);
    await expect(
      readEvidenceBatch(windowId, {
        threadId,
        items: [{ operationId: operationId(31), contentId: result.diff.contentId }],
      }),
    ).rejects.toMatchObject({ failure: { category: "unauthorized" } });

    fixture.evidenceValues.set(result.diff.contentId, "tampered");
    await expect(
      fixture.runtime.readEvidence(windowId, threadId, operationId(31), result.diff.contentId),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    fixture.evidenceValues.set(
      result.diff.contentId,
      "x".repeat(MAX_CODE_OPERATION_TEXT_BYTES + 1),
    );
    await expect(
      readEvidenceBatch(windowId, {
        threadId,
        items: [{ operationId: operationId(31), contentId: result.diff.contentId }],
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    fixture.close();
  });

  // Without an unborn head the observation never decodes, so the renderer never
  // receives a state token and every Git action stays unreachable in a checkout
  // that has no commits yet.
  it("reports a checkout with no commits yet as an unborn head with a usable state token", async () => {
    const fixture = runtimeFixture({
      gitObservation: {
        status: "ready",
        checkoutRoot: "/private/exact",
        head: { kind: "unborn", name: "main" },
        statusEntries: [{ path: "src/a.ts", index: "A", worktree: " " }],
        changedPaths: ["src/a.ts"],
        insertions: 1,
        deletions: 0,
        stagedSummary: [{ path: "src/a.ts", index: "A", worktree: " " }],
        diff: { text: "+first", byteLength: 6, truncated: false },
        remotes: [],
        upstream: null,
        worktrees: [
          {
            path: "/private/exact",
            head: "0".repeat(40),
            branch: "refs/heads/main",
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
          },
        ],
        stateToken: "b".repeat(64),
      },
    });

    const result = await fixture.runtime.execute(windowId, {
      kind: "observe-git",
      operationId: operationId(33),
      threadId,
      checkoutId,
      gitOperationId: operationId(34),
      maxDiffBytes: 1_024,
    });

    expect(result).toMatchObject({
      kind: "git-observed",
      head: { kind: "unborn", name: "main" },
      stateToken: "b".repeat(64),
      worktrees: [{ head: { kind: "unborn", name: "main" }, state: "active" }],
    });
    fixture.close();
  });

  it("reports a thread as executing for exactly as long as its provider turn runs", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
    });
    const startOperation = operationId(60);

    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });

    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    expect(fixture.runtimeWorks()).toEqual([
      { id: String(startOperation), kind: "provider-turn", state: "running" },
    ]);
    expect(fixture.boardActivity()).toMatchObject({ executing: true, awaitingInput: false });

    await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));

    await vi.waitFor(() =>
      expect(fixture.runtimeWorks().at(-1)).toEqual({
        id: String(startOperation),
        kind: "provider-turn",
        state: "completed",
      }),
    );
    expect(fixture.boardActivity()).toMatchObject({
      executing: false,
      awaitingInput: false,
      interrupted: false,
    });
    fixture.close();
  });

  it("keeps a thread executing until its shell exits", async () => {
    const fixture = runtimeFixture({ terminalExit: { exitCode: 0 } });
    const terminalId = operationId(70);

    await fixture.runtime.execute(windowId, {
      kind: "start-terminal",
      operationId: operationId(71),
      threadId,
      checkoutId,
      terminalId,
      columns: 100,
      rows: 30,
      credentialRefs: [],
    });

    expect(fixture.runtimeWorks()).toEqual([
      { id: String(terminalId), kind: "terminal", state: "running" },
    ]);
    expect(fixture.boardActivity()).toMatchObject({ executing: true });

    // A shell that ends on its own tells nobody. The next command that looks at
    // it is what closes the record, which is why every terminal command settles
    // it rather than only `stop-terminal`.
    fixture.exitTerminal();
    await fixture.runtime.execute(windowId, {
      kind: "attach-terminal",
      operationId: operationId(72),
      threadId,
      checkoutId,
      terminalId,
    });

    expect(fixture.runtimeWorks().at(-1)).toEqual({
      id: String(terminalId),
      kind: "terminal",
      state: "completed",
    });
    expect(fixture.boardActivity()).toMatchObject({ executing: false, awaitingInput: false });
    fixture.close();
  });

  it("preserves the operation result when its runtime board record cannot be journaled", async () => {
    const fixture = runtimeFixture({
      terminalExit: { exitCode: 0 },
      failRuntimeWorkJournal: true,
      throwRuntimeWorkReporter: true,
    });

    const result = await fixture.runtime.execute(windowId, {
      kind: "start-terminal",
      operationId: operationId(74),
      threadId,
      checkoutId,
      terminalId: operationId(75),
      columns: 100,
      rows: 30,
      credentialRefs: [],
    });

    expect(result).toMatchObject({ kind: "terminal-state", state: "running" });
    expect(fixture.runtimeWorkFailures).toEqual(["journal-unavailable"]);
    expect(fixture.runtimeWorks()).toEqual([]);
    fixture.close();
  });

  it("closes a repository test run that could not be executed", async () => {
    const fixture = runtimeFixture({});
    const testRunId = operationId(80);

    const result = await fixture.runtime.execute(windowId, {
      kind: "run-repository-test",
      operationId: operationId(81),
      threadId,
      checkoutId,
      testRunId,
      definition: {
        id: "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd",
        name: "test",
        source: {
          kind: "package-script",
          packagePath: "package.json",
          packageManager: "bun",
          script: "test",
        },
        argv: ["bun", "run", "test"],
        cwd: ".",
        environmentRefs: [],
        timeoutMs: 900_000,
        artifactPaths: [],
      },
    });

    // The discovery this fixture performs finds nothing, so the run is refused
    // before a process starts. The record still closes: work that never ran is
    // not work the board should keep showing as owed.
    expect(result).toMatchObject({ kind: "operation-failed" });
    expect(fixture.runtimeWorks()).toEqual([
      { id: String(testRunId), kind: "test", state: "running" },
      { id: String(testRunId), kind: "test", state: "failed" },
    ]);
    expect(fixture.boardActivity()).toMatchObject({ executing: false, awaitingInput: false });
    fixture.close();
  });

  // The push may have landed on the remote even though this host never learned
  // so. Calling it failed would let the thread read as Ready with work possibly
  // already published; `ambiguous` is what puts it in Waiting instead.
  it("leaves a push whose outcome it could not establish waiting rather than ready", async () => {
    // The fixture cannot observe the checkout, so the push never establishes
    // whether the remote took the refs.
    const fixture = runtimeFixture({});
    const gitOperationId = operationId(90);

    const result = await fixture.runtime.execute(windowId, {
      kind: "push-git",
      operationId: operationId(91),
      threadId,
      checkoutId,
      gitOperationId,
      remote: "origin",
      localRef: "refs/heads/feature/runtime",
      remoteRef: "refs/heads/feature/runtime",
      expectedHeadOid: "a".repeat(40),
      expectedStateToken: "b".repeat(64),
      confirmation: {
        remote: "origin",
        refspec: "refs/heads/feature/runtime:refs/heads/feature/runtime",
      },
      authorization: { kind: "full-access" },
    });

    expect(result).toMatchObject({ kind: "operation-failed" });
    expect(fixture.runtimeWorks()).toEqual([
      { id: String(gitOperationId), kind: "git", state: "running" },
      { id: String(gitOperationId), kind: "git", state: "ambiguous" },
    ]);
    expect(fixture.boardActivity()).toMatchObject({
      executing: false,
      awaitingInput: true,
      blockingReason: "Runtime work is waiting for a decision or input.",
    });
    fixture.close();
  });

  it("leaves a pull request GitHub never confirmed waiting rather than ready", async () => {
    const fixture = runtimeFixture({
      pullRequestTarget: true,
      pullRequestPort: {
        ensure: async () => ({ status: "unavailable" }),
        observeReview: async () => ({ status: "unavailable" }),
      },
    });
    const delivery = operationId(100);

    const created = await fixture.runtime.execute(windowId, {
      kind: "create-pull-request",
      operationId: delivery,
      threadId,
      checkoutId,
      title: "Add the board's runtime work",
      body: "Body",
      idempotencyKey: "runtime-work-delivery",
      authorization: { kind: "approved", approvalId: operationId(101) },
    });

    expect(created).toMatchObject({ kind: "pull-request-state", state: "unavailable" });
    expect(fixture.runtimeWorks()).toEqual([
      { id: String(delivery), kind: "delivery", state: "running" },
      { id: String(delivery), kind: "delivery", state: "ambiguous" },
    ]);
    expect(fixture.boardActivity()).toMatchObject({ executing: false, awaitingInput: true });
    fixture.close();
  });

  // The Waiting column exists for exactly this: an effect the host refuses
  // until someone decides. The approved retry carries the same operation, so it
  // continues that record rather than leaving a second one owed forever.
  it("holds delivery waiting until the effect is approved, then continues the same record", async () => {
    let approved = false;
    const fixture = runtimeFixture({
      pullRequestTarget: true,
      approvalValidator: () => approved,
      pullRequestPort: {
        ensure: async () => ({
          status: "created",
          pullRequest: {
            number: 7,
            url: "https://github.com/octant/octant/pull/7",
            baseRepository: "octant/octant",
            baseBranch: "development",
            headOwner: "octant",
            headBranch: "feature/runtime",
          },
        }),
        observeReview: async () => ({ status: "unavailable" }),
      },
    });
    const delivery = operationId(120);
    const command = {
      kind: "create-pull-request" as const,
      operationId: delivery,
      threadId,
      checkoutId,
      title: "Add the board's runtime work",
      body: "Body",
      idempotencyKey: "runtime-work-delivery",
    };

    const refused = await fixture.runtime.execute(windowId, {
      ...command,
      authorization: { kind: "full-access" },
    });

    expect(refused).toMatchObject({ failure: { category: "waiting" } });
    expect(fixture.runtimeWorks().at(-1)).toEqual({
      id: String(delivery),
      kind: "delivery",
      state: "waiting",
    });
    expect(fixture.boardActivity()).toMatchObject({
      awaitingInput: true,
      blockingReason: "Runtime work is waiting for a decision or input.",
    });

    approved = true;
    await fixture.runtime.execute(windowId, {
      ...command,
      authorization: { kind: "approved", approvalId: operationId(121) },
    });

    expect(fixture.runtimeWorks().at(-1)).toEqual({
      id: String(delivery),
      kind: "delivery",
      state: "completed",
    });
    expect(fixture.boardActivity()).toMatchObject({ executing: false, awaitingInput: false });
    fixture.close();
  });

  // A record whose work resolves inside the call could only ever say "already
  // finished", so the journal keeps none: the board reads runtime work, and a
  // read or an index edit is not runtime work.
  it("journals no runtime work for observing Git or staging paths", async () => {
    const fixture = runtimeFixture({});

    await fixture.runtime.execute(windowId, {
      kind: "observe-git",
      operationId: operationId(110),
      threadId,
      checkoutId,
      gitOperationId: operationId(111),
      maxDiffBytes: 1_024,
    });
    await fixture.runtime.execute(windowId, {
      kind: "stage-git",
      operationId: operationId(112),
      threadId,
      checkoutId,
      gitOperationId: operationId(113),
      paths: ["src/main.ts"],
      expectedStateToken: "b".repeat(64),
    });

    expect(fixture.runtimeWorks()).toEqual([]);
    fixture.close();
  });
});

function runtimeFixture(options: {
  provider?: ProviderDriver | undefined;
  terminalExit?: { readonly exitCode: number };
  pullRequestPort?: Parameters<typeof createCodeOperationRuntime>[0]["pullRequestPort"];
  pullRequestTarget?: boolean;
  repositoryTestProcessPort?: Parameters<
    typeof createCodeOperationRuntime
  >[0]["repositoryTestProcessPort"];
  credential?: string | undefined;
  credentialReferences?: readonly { environmentName: string; reference: string }[];
  gitObservation?: GitObservationResult;
  gitReadDiff?: (
    input: Parameters<GitObservationPort["readDiff"]>[0],
  ) => Promise<GitScopedDiffResult>;
  approvalValidator?: boolean | (() => boolean);
  failRuntimeWorkJournal?: boolean;
  throwRuntimeWorkReporter?: boolean;
  evidencePut?: (
    content: string,
    metadata?: { readonly truncated?: boolean },
  ) => ReturnType<typeof storedEvidence>;
}) {
  const directory = mkdtempSync(join(tmpdir(), "octant-code-runtime-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const journal = new Journal({
    connection,
    registry: new EventRegistry()
      .register(CODE_OPERATION_EVENT_RECORDED, 1, CodeOperationEventFrame)
      .register(CODE_RUNTIME_WORK_UPDATED, 1, CodeRuntimeWorkUpdated),
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(new CodeProjection()),
    clock: () => now,
  });
  if (options.failRuntimeWorkJournal === true) {
    const append = journal.append.bind(journal);
    vi.spyOn(journal, "append").mockImplementation((input: Parameters<Journal["append"]>[0]) => {
      const aggregate =
        typeof input === "object" && input !== null && "aggregate" in input
          ? input.aggregate
          : undefined;
      if (
        typeof aggregate === "object" &&
        aggregate !== null &&
        "aggregateType" in aggregate &&
        aggregate.aggregateType === "code-runtime"
      )
        throw new Error("runtime work journal unavailable");
      return append(input);
    });
  }
  let activeThread = thread();
  const checkout = decodeCodeCheckoutIdentity({
    id: checkoutId,
    repositoryId: activeThread.repositoryId,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "feature/runtime", oid: "a".repeat(40) },
    observedAt: now,
  });
  const access = vi.fn(async () => true);
  const prompt = evidence(40);
  const response = evidence(41);
  const evidenceValues = new Map([
    [prompt.contentId, "Implement this."],
    [response.contentId, "A"],
  ]);
  let evidenceCounter = 50;
  let uuidCounter = 100;
  const runtimeWorkFailures: string[] = [];
  let exitTerminal: (() => void) | undefined;
  const runtime = createCodeOperationRuntime({
    persistence: {
      journal,
      readCodeThread: (id) => (id === threadId ? activeThread : undefined),
      readCodeCheckout: (id) => (id === checkoutId ? checkout : undefined),
      readReviewFinding: () => undefined,
      readReviewFindings: () => [],
    },
    windowAccess: { canAccessProject: access },
    resolveCheckoutRoot: async () => ({
      checkoutRoot: "/private/exact",
      shell: "/bin/zsh",
      credentialReferences: options.credentialReferences ?? [],
      environment: {},
    }),
    resolveProviderDriver: async () => options.provider,
    credentialResolver: { resolve: async () => options.credential },
    resolvePullRequestTarget: async () =>
      options.pullRequestTarget === true
        ? {
            authorization: "confirmed-delivery-target" as const,
            baseRepository: "octant/octant",
            baseBranch: "development",
            head: "octant:feature/runtime",
          }
        : undefined,
    reviewFiles: { resolve: () => undefined },
    evidence: {
      put: (content, metadata) => {
        if (options.evidencePut !== undefined) return options.evidencePut(content, metadata);
        const reference = storedEvidence(++evidenceCounter, content, metadata?.truncated);
        evidenceValues.set(reference.contentId, content);
        return reference;
      },
      read: async (reference) => evidenceValues.get(reference.contentId),
    },
    ...(options.approvalValidator === false
      ? {}
      : {
          approvalValidator: {
            validate: async () =>
              typeof options.approvalValidator === "function" ? options.approvalValidator() : true,
          },
        }),
    actor,
    clock: () => now,
    uuid: () => `90000000-0000-4000-8000-${(++uuidCounter).toString().padStart(12, "0")}`,
    reportRuntimeWorkFailure: (failure) => {
      runtimeWorkFailures.push(failure.kind);
      if (options.throwRuntimeWorkReporter === true) throw new Error("diagnostic reporter failed");
    },
    terminalProcessPort: {
      start: () => {
        const exit = options.terminalExit;
        if (exit === undefined) throw new Error("not used");
        return {
          write: vi.fn(),
          resize: vi.fn(),
          onData: () => () => undefined,
          onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
            exitTerminal = () => listener(exit);
            return () => undefined;
          },
          pause: vi.fn(),
          resume: vi.fn(),
          close: vi.fn(async () => undefined),
        };
      },
    },
    repositoryTestProcessPort: options.repositoryTestProcessPort ?? {
      execute: async () => ({
        termination: "unavailable" as const,
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        parserFailed: false,
        cleanupUncertain: false,
      }),
      readArtifact: async () => undefined,
    },
    ...(options.pullRequestPort === undefined ? {} : { pullRequestPort: options.pullRequestPort }),
    gitObservationPort: {
      observe: async () => options.gitObservation ?? { status: "unavailable" as const },
      ...(options.gitReadDiff === undefined ? {} : { readDiff: options.gitReadDiff }),
    },
    gitMutationPort: {
      stage: async () => ({ status: "failed" as const }),
      unstage: async () => ({ status: "failed" as const }),
      commit: async () => ({ status: "failed" as const }),
      push: async () => ({ status: "failed" as const }),
      discard: async () => ({ status: "failed" as const }),
      revertCommit: async () => ({ status: "failed" as const }),
      snapshotWorkingTree: async () => ({ status: "failed" as const }),
      restoreWorkingTree: async () => ({ status: "failed" as const }),
      releaseCheckpoint: async () => {},
    },
  });
  return {
    runtime,
    access,
    prompt,
    response,
    evidenceValues,
    setThread: (next: CodeThread) => {
      activeThread = next;
    },
    /** Fire the shell's own exit, the way a `exit` typed into it would. */
    exitTerminal: () => exitTerminal?.(),
    /** Every runtime work state this runtime journalled, oldest first. */
    runtimeWorks: (): ReadonlyArray<{
      readonly id: string;
      readonly kind: string;
      readonly state: string;
    }> =>
      journal
        .replayAggregateType({ aggregateType: "code-runtime", afterSequence: 0, limit: 1_000 })
        .map((envelope) => {
          const { work } = envelope.payload as { readonly work: CodeRuntimeWork };
          return { id: String(work.id), kind: work.kind, state: work.state };
        }),
    /** The board reads the rebuildable Code projection, not journal history. */
    boardActivity: () => boardRuntimeActivityFromWorks(readCodeRuntimeWorks(connection, threadId)),
    runtimeWorkFailures,
    close: () => connection.close(),
  };
}

function providerConnection(queue: Queue.Queue<ProviderRuntimeEvent>): ProviderConnection {
  return {
    subscribe: Effect.succeed(Stream.fromQueue(queue)),
    start: vi.fn(() => Effect.succeed({ sessionId })),
    resume: vi.fn(() => Effect.succeed({ sessionId })),
    send: vi.fn(() => Effect.void),
    interrupt: vi.fn(() => Effect.void),
    stop: vi.fn(() => Effect.void),
    answerApproval: vi.fn(() => Effect.void),
    answerUserInput: vi.fn(() => Effect.void),
    answerTool: vi.fn(() => Effect.void),
  };
}

function providerDriver(connection: ProviderConnection): ProviderDriver {
  return { acquire: () => Effect.succeed(connection) } as unknown as ProviderDriver;
}

function thread(): CodeThread {
  return decodeCodeThread({
    id: threadId,
    projectId: "90000000-0000-4000-8000-000000000006",
    bindingRevisionId: "90000000-0000-4000-8000-000000000007",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId,
    title: "Runtime",
    lifecycle: "active",
    providerInstanceId: "90000000-0000-4000-8000-000000000008",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/runtime",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function evidence(id: number, byteLength = 20, truncated?: boolean) {
  return decodeCodeEvidenceReference({
    contentId: `90000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
    digest: id.toString(16).padStart(64, "0"),
    byteLength,
    ...(truncated === undefined ? {} : { truncated }),
  });
}

function storedEvidence(id: number, content: string, truncated?: boolean) {
  const bytes = new TextEncoder().encode(content);
  return decodeCodeEvidenceReference({
    contentId: `90000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    ...(truncated === undefined ? {} : { truncated }),
  });
}

function operationId(id: number) {
  return decodeCodeOperationId(`90000000-0000-4000-8000-${id.toString().padStart(12, "0")}`);
}

function providerEvent(
  value: { kind: ProviderRuntimeEvent["kind"] } & Record<string, unknown>,
): ProviderRuntimeEvent {
  return {
    instanceId: thread().providerInstanceId,
    sessionId,
    sequence: 1,
    correlationId: "90000000-0000-4000-8000-000000000099",
    occurredAt: now,
    ...value,
  } as ProviderRuntimeEvent;
}
