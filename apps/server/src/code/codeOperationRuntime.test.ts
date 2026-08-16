import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorId,
  CodeOperationEventFrame,
  MAX_CODE_OPERATION_TEXT_BYTES,
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceReference,
  decodeCodeOperationId,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProviderSessionId,
  type CodeOperationEventFrame as OperationFrame,
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
import { CODE_OPERATION_EVENT_RECORDED } from "./codeOperationEventStore";
import { createCodeOperationRuntime } from "./codeOperationRuntime";
import { CodeEvidenceCapacityExceeded } from "./codeEvidenceStore";
import type { GitObservationResult } from "./gitObservationPort";

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

  it("normalizes scp remotes and preserves worktree and truncation evidence", async () => {
    const fixture = runtimeFixture({
      gitObservation: {
        status: "ready",
        checkoutRoot: "/private/exact",
        head: { oid: "a".repeat(40), branch: { kind: "named", name: "feature/runtime" } },
        statusEntries: [{ path: "src/a.ts", index: " ", worktree: "M" }],
        changedPaths: ["src/a.ts"],
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

    fixture.evidenceValues.set(result.diff.contentId, "tampered");
    await expect(
      fixture.runtime.readEvidence(windowId, threadId, operationId(31), result.diff.contentId),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    fixture.close();
  });
});

function runtimeFixture(options: {
  provider?: ProviderDriver | undefined;
  credential?: string | undefined;
  credentialReferences?: readonly { environmentName: string; reference: string }[];
  gitObservation?: GitObservationResult;
  approvalValidator?: boolean;
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
    registry: new EventRegistry().register(
      CODE_OPERATION_EVENT_RECORDED,
      1,
      CodeOperationEventFrame,
    ),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
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
    resolvePullRequestTarget: async () => undefined,
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
      : { approvalValidator: { validate: async () => true } }),
    actor,
    clock: () => now,
    uuid: () => `90000000-0000-4000-8000-${(++uuidCounter).toString().padStart(12, "0")}`,
    terminalProcessPort: {
      start: () => {
        throw new Error("not used");
      },
    },
    repositoryTestProcessPort: {
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
    gitObservationPort: {
      observe: async () => options.gitObservation ?? { status: "unavailable" as const },
    },
    gitMutationPort: {
      stage: async () => ({ status: "failed" as const }),
      commit: async () => ({ status: "failed" as const }),
      push: async () => ({ status: "failed" as const }),
      revertCommit: async () => ({ status: "failed" as const }),
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
    close: () => connection.close(),
  };
}

function providerConnection(queue: Queue.Queue<ProviderRuntimeEvent>): ProviderConnection {
  return {
    events: Stream.fromQueue(queue),
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
