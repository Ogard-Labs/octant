import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorId,
  CodeOperationEventFrame,
  CodeRuntimeWorkUpdated,
  ProductFeedbackCaptured,
  ProductFeedbackDelivered,
  MAX_CODE_OPERATION_SUMMARY_BYTES,
  MAX_CODE_OPERATION_TEXT_BYTES,
  decodeCodeCheckoutId,
  decodeCodeRepositoryTestDefinition,
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceReference,
  decodeCodeOperationEvent,
  decodeCodeOperationId,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProviderSessionId,
  decodeBrowserAutomationSnapshot,
  decodeToolActionAuthority,
  type CodeOperationEventFrame as OperationFrame,
  type CodeRuntimeWork,
  type CodeThread,
  type CodeThreadId,
  type ProviderRuntimeEvent,
  type WindowId,
} from "@octant/contracts";
import { Effect, Queue, Stream } from "effect";
import type {
  ProviderConnection,
  ProviderDriver,
  ProviderSessionHandle,
  ProviderSessionStart,
} from "@octant/provider-sdk/driver";
import { browserUseSelection } from "@octant/plugin-host/browser-use";
import { computerUseSelection } from "@octant/plugin-host/computer-use";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { ProductFeedbackService } from "../browser/productFeedbackService";
import { createProductFeedbackTurnPort } from "../browser/productFeedbackTurnPort";
import {
  ProductFeedbackProjection,
  readProductFeedbackNote,
  readProductFeedbackNotes,
} from "../persistence/productFeedbackProjection";
import {
  CodeProjection,
  readCodeRuntimeWorks,
  readCodeRuntimeWorkAggregateVersion,
} from "../persistence/codeProjection";
import { CODE_OPERATION_EVENT_RECORDED, CodeOperationEventStore } from "./codeOperationEventStore";
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
    expect(challenge?.detail).toContain(`Thread: ${thread().title}`);
    expect(challenge?.detail).toContain("Branch: feature/runtime");
    for (const identity of [
      threadId,
      checkoutId,
      thread().projectId,
      thread().repositoryId,
      "a".repeat(40),
    ]) {
      expect(challenge?.detail).not.toContain(identity);
    }
    expect(challenge?.detail).toMatch(/^Start repository terminal/);
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

  it("says an input approval covers the Simulator for a while, not one tap", async () => {
    const fixture = runtimeFixture({ approvalValidator: false });
    const challenge = await fixture.runtime.prepareApproval(windowId, {
      effect: {
        kind: "apple-action",
        request: {
          actionId: operationId(810) as never,
          correlationId: operationId(811) as never,
          authority: {
            hostId: "90000000-0000-4000-8000-000000000010" as never,
            mode: "code" as const,
            projectId: thread().projectId,
            providerInstanceId: thread().providerInstanceId,
            extension: { kind: "core" as const },
          },
          threadId,
          checkoutId,
          kind: "tap" as const,
          simulatorId: "90000000-0000-4000-8000-000000000011" as never,
          requestedBy: { kind: "local-user" as const, actorId: operationId(812) as never },
          point: { x: 10, y: 20 },
          timeoutMs: 30_000,
          approval: { kind: "pending" as const },
        },
      },
    });
    expect(challenge?.message).toBe("Allow input to this Simulator?");
    expect(challenge?.detail).toContain("for 15 minutes after each input");
    fixture.close();
  });

  it("says an input approval covers the Android emulator for a while, not one tap", async () => {
    const fixture = runtimeFixture({ approvalValidator: false });
    const challenge = await fixture.runtime.prepareApproval(windowId, {
      effect: {
        kind: "android-action",
        request: {
          actionId: operationId(820) as never,
          correlationId: operationId(821) as never,
          authority: {
            hostId: "90000000-0000-4000-8000-000000000010" as never,
            mode: "code" as const,
            projectId: thread().projectId,
            providerInstanceId: thread().providerInstanceId,
            extension: { kind: "core" as const },
          },
          threadId,
          checkoutId,
          kind: "open-input" as const,
          emulatorId: "Pixel_8_API_34" as never,
          requestedBy: { kind: "local-user" as const, actorId: operationId(822) as never },
          timeoutMs: 30_000,
          approval: { kind: "pending" as const },
        },
      },
    });
    expect(challenge?.message).toBe("Allow input to this emulator?");
    expect(challenge?.detail).toContain("for 15 minutes after each input");
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

  it("releases the spend reservation when a Code turn is cancelled", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const settle = vi.fn();
    const admit = vi.fn().mockReturnValue({
      status: "admitted",
      reservedTokens: 100,
      reservations: [{ scopeKind: "thread", scopeId: String(threadId), reservedTokens: 100 }],
    });
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
      spendCeiling: { admit, settle },
    });
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: operationId(21),
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    expect(admit).toHaveBeenCalledOnce();
    await fixture.runtime.execute(windowId, {
      kind: "cancel-provider-turn",
      operationId: operationId(22),
      threadId,
      checkoutId,
    });
    expect(settle).toHaveBeenCalledOnce();
    fixture.close();
  });

  it("releases the spend reservation when a Code turn fails to start", async () => {
    const settle = vi.fn();
    const admit = vi.fn().mockReturnValue({
      status: "admitted",
      reservedTokens: 100,
      reservations: [{ scopeKind: "thread", scopeId: String(threadId), reservedTokens: 100 }],
    });
    const fixture = runtimeFixture({
      provider: undefined,
      approvalValidator: false,
      spendCeiling: { admit, settle },
    });
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: operationId(23),
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    fixture.close();
  });

  it("tells the host once that a person asked the thread for a turn, and not again on replay", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const onProviderTurnRequested = vi.fn();
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
      onProviderTurnRequested,
    });
    const startOperation = operationId(11);
    const command = {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    } as const;

    await fixture.runtime.execute(windowId, command);
    expect(onProviderTurnRequested).toHaveBeenCalledTimes(1);
    expect(onProviderTurnRequested).toHaveBeenCalledWith(threadId);

    await fixture.runtime.execute(windowId, command);
    expect(onProviderTurnRequested).toHaveBeenCalledTimes(1);
    fixture.close();
  });

  it("does not announce a host-dispatched limit recovery as a person's turn request", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const onProviderTurnRequested = vi.fn();
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
      onProviderTurnRequested,
    });

    await fixture.runtime.execute(
      windowId,
      {
        kind: "start-provider-turn",
        operationId: operationId(12),
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
      },
      { limitRecovery: true },
    );
    expect(onProviderTurnRequested).not.toHaveBeenCalled();
    fixture.close();
  });

  it("keeps feedback images pending through refused credentials and sends them once on retry", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const entered = Promise.withResolvers<void>();
    const credential = Promise.withResolvers<string>();
    let current = true;
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
      credentialReferences: [{ environmentName: "TOKEN", reference: "token" }],
      credentialResolver: {
        resolve: () => {
          entered.resolve();
          return credential.promise;
        },
      },
    });
    try {
      await fixture.feedback.execute(windowId, {
        kind: "capture-product-feedback",
        threadId,
        mode: "code",
        contextId: operationId(40),
        point: { x: 0.3, y: 0.5 },
        comment: "Align this button.",
      });
      const command = {
        kind: "start-provider-turn",
        operationId: operationId(13),
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
      } as const;
      const pending = fixture.runtime.execute(windowId, command, {
        admissionCurrent: () => current,
      });
      await entered.promise;
      current = false;
      credential.resolve("credential-value");
      await expect(pending).resolves.toMatchObject({ admission: "refused" });
      expect(connection.send).not.toHaveBeenCalled();
      expect(await fixture.feedback.list(windowId, threadId)).toMatchObject([
        { lifecycle: "pending", crop: { contentId: expect.any(String) } },
      ]);

      current = true;
      const retry = { ...command, operationId: operationId(14), sessionId: operationId(14) };
      await expect(
        fixture.runtime.execute(windowId, retry, { admissionCurrent: () => current }),
      ).resolves.toMatchObject({ state: "running" });
      await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
      expect(connection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining("Align this button.") }),
          ]),
          attachments: [
            expect.objectContaining({ bytes: new TextEncoder().encode("captured image") }),
          ],
        }),
      );
      await fixture.runtime.execute(windowId, retry);
      expect(connection.send).toHaveBeenCalledOnce();
      expect(await fixture.feedback.list(windowId, threadId)).toMatchObject([
        { lifecycle: "delivered", version: 2 },
      ]);
      expect(fixture.feedback.deliver({ threadId, operationId: operationId(15) })).toEqual([]);
      await fixture.runtime.execute(windowId, {
        kind: "cancel-provider-turn",
        operationId: operationId(16),
        threadId,
        checkoutId,
      });
    } finally {
      fixture.close();
    }
  });

  it("keeps feedback claimed when an admitted send loses its acknowledgement", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const acknowledgement = Promise.withResolvers<void>();
    const connection = {
      ...providerConnection(queue),
      send: vi.fn<ProviderConnection["send"]>(() =>
        Effect.tryPromise({
          try: () => acknowledgement.promise,
          catch: () => ({ category: "provider-failed", message: "Send acknowledgement lost." }),
        }),
      ),
    };
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
    });
    try {
      await fixture.feedback.execute(windowId, {
        kind: "capture-product-feedback",
        threadId,
        mode: "code",
        contextId: operationId(40),
        point: { x: 0.3, y: 0.5 },
        comment: "Align this button.",
      });
      await expect(
        fixture.runtime.execute(windowId, {
          kind: "start-provider-turn",
          operationId: operationId(13),
          threadId,
          checkoutId,
          sessionId,
          prompt: fixture.prompt,
        }),
      ).resolves.toMatchObject({ state: "running" });
      await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
      expect(fixture.feedback.deliver({ threadId, operationId: operationId(14) })).toEqual([]);
      acknowledgement.reject(new Error("connection closed"));
      await vi.waitFor(() => expect(fixture.runtimeWorks().at(-1)?.state).toBe("failed"));
      expect(await fixture.feedback.list(windowId, threadId)).toMatchObject([
        { lifecycle: "delivered", version: 2 },
      ]);
      expect(fixture.feedback.deliver({ threadId, operationId: operationId(15) })).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("refuses a host turn revoked during runtime provider preparation without starting the provider", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const driver = providerDriver(connection);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let current = true;
    const fixture = runtimeFixture({
      provider: driver,
      approvalValidator: false,
      resolveProviderDriver: async () => {
        entered.resolve();
        await release.promise;
        return driver;
      },
    });
    try {
      const pending = fixture.runtime.execute(
        windowId,
        {
          kind: "start-provider-turn",
          operationId: operationId(13),
          threadId,
          checkoutId,
          sessionId,
          prompt: fixture.prompt,
        },
        { admissionCurrent: () => current },
      );
      await entered.promise;
      current = false;
      release.resolve();
      await expect(pending).resolves.toMatchObject({
        kind: "provider-turn-state",
        state: "failed",
        admission: "refused",
        failure: { category: "unauthorized" },
      });
      expect(connection.start).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });

  it("refuses a saved reasoning choice that discovery no longer offers before admitting the turn", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const admit = vi.fn();
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
      spendCeiling: { admit, settle: vi.fn() },
      probeProvider: async () => ({
        readiness: "ready",
        models: [
          {
            id: thread().modelId,
            displayName: "Model A",
            reasoning: "supported",
            inputModalities: ["text"],
            source: "discovered",
            verification: "verified",
            options: [{ id: "effort", displayName: "Effort", kind: "selection", values: ["low"] }],
          },
        ],
      }),
    });
    fixture.setThread({ ...thread(), modelOptionValues: { effort: "high" } });
    await expect(
      fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(13),
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
      }),
    ).rejects.toMatchObject({ failure: { category: "unsupported" } });
    expect(admit).not.toHaveBeenCalled();
    expect(connection.start).not.toHaveBeenCalled();
    fixture.close();
  });

  it("refuses a provider turn before admission when the Project policy no longer allows it", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const admit = vi.fn();
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
      spendCeiling: { admit, settle: vi.fn() },
      isProviderModelAllowed: () => false,
    });

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(13),
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
      }),
    ).rejects.toMatchObject({ failure: { category: "unauthorized" } });
    expect(admit).not.toHaveBeenCalled();
    fixture.close();
  });

  it("refuses to start a turn when the thread cannot be brought back, and records no work for it", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
      onProviderTurnRequested: () => {
        throw new Error("journal is unavailable");
      },
    });

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(12),
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
      }),
    ).rejects.toThrow("journal is unavailable");
    expect(connection.send).not.toHaveBeenCalled();
    expect(fixture.runtimeWorks()).toEqual([]);
    fixture.close();
  });

  it.each(["approved", "denied", "cancelled"] as const)(
    "honors %s browser approval without changing thread access",
    async (decision) => {
      const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
      const request = new AbortController();
      const provider = { ...providerConnection(queue), toolRequestSignal: () => request.signal };
      const authority = decodeToolActionAuthority({
        hostId: "90000000-0000-4000-8000-000000000001",
        mode: "code",
        projectId: thread().projectId,
        rootId: "90000000-0000-4000-8000-000000000009",
        worktreeId: checkoutId,
        providerInstanceId: thread().providerInstanceId,
        extension: { kind: "core" },
      });
      const snapshot = decodeBrowserAutomationSnapshot({
        status: "running",
        threadId,
        evidence: [],
        context: {
          contextId: "90000000-0000-4000-8000-000000000060",
          threadId,
          actionId: "90000000-0000-4000-8000-000000000061",
          correlationId: "90000000-0000-4000-8000-000000000062",
          authority,
          policy: {
            profileMode: "isolated",
            allowedOrigins: ["https://example.com"],
            credentialFieldProtection: true,
            maxConcurrentTabs: 1,
            sessionTimeoutMs: 600000,
          },
          state: "active",
          createdAt: now,
        },
      });
      let currentSnapshot = decodeBrowserAutomationSnapshot({
        status: "ready",
        threadId,
        evidence: [],
      });
      const create = vi.fn(async () => {
        currentSnapshot = snapshot;
        return snapshot;
      });
      const act = vi.fn(async () => snapshot);
      const fixture = runtimeFixture({
        provider: providerDriver(provider),
        browserAutomation: {
          resolveAuthority: () => authority,
          inspectThread: () => currentSnapshot,
          create,
          act,
          releaseThread: vi.fn(async () => snapshot),
        },
      });
      try {
        const operation = operationId(70);
        await fixture.runtime.execute(windowId, {
          kind: "start-provider-turn",
          operationId: operation,
          threadId,
          checkoutId,
          sessionId,
          prompt: fixture.prompt,
        });
        await vi.waitFor(() => expect(provider.send).toHaveBeenCalledOnce());
        await Effect.runPromise(
          Queue.offer(
            queue,
            providerEvent({
              kind: "tool-request",
              requestId: "browser-request",
              toolName: "octant_browser",
              inputJson: '{"operation":"navigate","url":"https://example.com"}',
            }),
          ),
        );
        let approval: Extract<OperationFrame["event"], { kind: "approval-requested" }> | undefined;
        await vi.waitFor(async () => {
          const frames = await fixture.runtime.subscribe(windowId, threadId, operation, 0, 30);
          approval = frames
            .map((frame) => frame.event)
            .find((event) => event.kind === "approval-requested");
          expect(approval).toBeDefined();
        });
        expect(create).not.toHaveBeenCalled();
        if (approval === undefined) throw new Error("Expected browser approval");
        if (decision === "cancelled") request.abort();
        await fixture.runtime.execute(windowId, {
          kind: "answer-provider-approval",
          operationId: operationId(71),
          threadId,
          checkoutId,
          approvalId: approval.approvalId,
          decision: decision === "denied" ? "denied" : "approved",
        });
        if (decision === "cancelled") {
          await vi.waitFor(async () => {
            const frames = await fixture.runtime.subscribe(windowId, threadId, operation, 0, 30);
            expect(
              frames.some(
                (frame) =>
                  frame.event.kind === "tool-activity" &&
                  frame.event.state === "failed" &&
                  frame.event.summary === "App-managed action was cancelled.",
              ),
            ).toBe(true);
          });
          expect(provider.answerTool).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() =>
            expect(provider.answerTool).toHaveBeenCalledWith(
              expect.objectContaining({
                requestId: "browser-request",
                isError: decision === "denied",
              }),
            ),
          );
        }
        expect(create).toHaveBeenCalledTimes(decision === "approved" ? 1 : 0);
        expect(act).toHaveBeenCalledTimes(decision === "approved" ? 1 : 0);
        if (decision === "approved") {
          await fixture.runtime.execute(windowId, {
            kind: "cancel-provider-turn",
            operationId: operationId(72),
            threadId,
            checkoutId,
          });
          await vi.waitFor(() => expect(provider.stop).toHaveBeenCalled());
          const nextOperation = operationId(73);
          await fixture.runtime.execute(windowId, {
            kind: "start-provider-turn",
            operationId: nextOperation,
            threadId,
            checkoutId,
            sessionId,
            prompt: fixture.prompt,
          });
          await vi.waitFor(() => expect(provider.send).toHaveBeenCalledTimes(2));
          await Effect.runPromise(
            Queue.offer(
              queue,
              providerEvent({
                kind: "tool-request",
                requestId: "browser-again",
                toolName: "octant_browser",
                inputJson: '{"operation":"navigate","url":"https://example.com"}',
              }),
            ),
          );
          await vi.waitFor(async () => {
            const frames = await fixture.runtime.subscribe(
              windowId,
              threadId,
              nextOperation,
              0,
              30,
            );
            expect(frames.some((frame) => frame.event.kind === "approval-requested")).toBe(true);
          });
          expect(act).toHaveBeenCalledTimes(1);
        }
      } finally {
        await fixture.runtime.close();
        fixture.close();
      }
    },
  );

  it.each([true, false])(
    "resumes without replay when a replacement cursor is returned: %s",
    async (replacementCursor) => {
      const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
      const connection = providerConnection(queue);
      if (!replacementCursor)
        vi.mocked(connection.resume).mockImplementation((input) =>
          Effect.succeed({ sessionId: input.sessionId }),
        );
      const fixture = runtimeFixture({ provider: providerDriver(connection) });
      try {
        await fixture.runtime.execute(windowId, {
          kind: "start-provider-turn",
          operationId: operationId(80),
          threadId,
          checkoutId,
          sessionId,
          prompt: fixture.prompt,
        });
        await vi.waitFor(() => expect(connection.send).toHaveBeenCalledTimes(1));
        await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));
        await vi.waitFor(() => expect(connection.stop).toHaveBeenCalledOnce());
        const nextPrompt = storedEvidence(82, "main");
        fixture.evidenceValues.set(nextPrompt.contentId, "main");
        await fixture.runtime.execute(windowId, {
          kind: "start-provider-turn",
          operationId: operationId(81),
          threadId,
          checkoutId,
          sessionId: decodeProviderSessionId("90000000-0000-4000-8000-000000000081"),
          prompt: nextPrompt,
        });
        await vi.waitFor(() => expect(connection.send).toHaveBeenCalledTimes(2));
        expect(connection.start).toHaveBeenCalledOnce();
        expect(connection.resume).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId,
            resumeCursor: { driverKind: "codex", value: "native-code-session" },
          }),
        );
        expect(vi.mocked(connection.send).mock.calls[1]?.[0]).toMatchObject({
          sessionId,
          prompt: "main",
        });
        expect(vi.mocked(connection.send).mock.calls[1]?.[0].context).toBeUndefined();
        await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));
        await vi.waitFor(() => expect(connection.stop).toHaveBeenCalledTimes(2));
        await fixture.runtime.execute(windowId, {
          kind: "start-provider-turn",
          operationId: operationId(83),
          threadId,
          checkoutId,
          sessionId,
          prompt: nextPrompt,
        });
        await vi.waitFor(() => expect(connection.send).toHaveBeenCalledTimes(3));
        expect(connection.start).toHaveBeenCalledOnce();
        expect(connection.resume).toHaveBeenLastCalledWith(
          expect.objectContaining({
            resumeCursor: { driverKind: "codex", value: "native-code-session" },
          }),
        );
      } finally {
        await fixture.runtime.close();
        fixture.close();
      }
    },
  );

  it.each([true, false])(
    "carries the conversation on after a switch to another model of the same provider only when it can: %s",
    async (canSwitch) => {
      const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
      const connection = providerConnection(queue);
      const fixture = runtimeFixture({
        provider: providerDriver(connection),
        supportsModelSwitch: canSwitch,
      });
      try {
        await fixture.runtime.execute(windowId, {
          kind: "start-provider-turn",
          operationId: operationId(84),
          threadId,
          checkoutId,
          sessionId,
          prompt: fixture.prompt,
        });
        await vi.waitFor(() => expect(connection.send).toHaveBeenCalledTimes(1));
        await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));
        await vi.waitFor(() => expect(connection.stop).toHaveBeenCalledOnce());
        fixture.setThread(decodeCodeThread({ ...thread(), modelId: "model-b", version: 2 }));
        const nextPrompt = storedEvidence(86, "main");
        fixture.evidenceValues.set(nextPrompt.contentId, "main");
        await fixture.runtime.execute(windowId, {
          kind: "start-provider-turn",
          operationId: operationId(85),
          threadId,
          checkoutId,
          sessionId: decodeProviderSessionId("90000000-0000-4000-8000-000000000085"),
          prompt: nextPrompt,
        });
        if (canSwitch) {
          await vi.waitFor(() => expect(connection.send).toHaveBeenCalledTimes(2));
          expect(connection.start).toHaveBeenCalledOnce();
          expect(connection.resume).toHaveBeenCalledWith(
            expect.objectContaining({
              sessionId,
              modelId: "model-b",
              resumeCursor: { driverKind: "codex", value: "native-code-session" },
            }),
          );
          const frames = await fixture.runtime.subscribe(
            windowId,
            threadId,
            operationId(85),
            0,
            20,
          );
          expect(frames.map((frame) => frame.event)).toContainEqual(
            expect.objectContaining({ kind: "provider-session-ready", modelId: "model-b" }),
          );
        } else {
          expect(connection.resume).not.toHaveBeenCalled();
          expect(connection.send).toHaveBeenCalledTimes(1);
        }
      } finally {
        await fixture.runtime.close();
        fixture.close();
      }
    },
  );

  it("adds fixed Browser guidance when the task explicitly selects Browser", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const provider = providerConnection(queue);
    const authority = decodeToolActionAuthority({
      hostId: "90000000-0000-4000-8000-000000000010",
      mode: "code",
      projectId: thread().projectId,
      rootId: "90000000-0000-4000-8000-000000000009",
      worktreeId: checkoutId,
      providerInstanceId: thread().providerInstanceId,
      extension: { kind: "core" },
    });
    const browserSnapshot = decodeBrowserAutomationSnapshot({
      status: "ready",
      threadId,
      evidence: [],
    });
    const fixture = runtimeFixture({
      provider: providerDriver(provider),
      browserAutomation: {
        resolveAuthority: () => authority,
        inspectThread: () => browserSnapshot,
        create: async () => browserSnapshot,
        act: async () => browserSnapshot,
        releaseThread: async () => browserSnapshot,
      },
    });
    try {
      await fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(74),
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
        extensionSelections: [browserUseSelection("code-browser-guidance")],
      });
      await vi.waitFor(() => expect(provider.send).toHaveBeenCalledOnce());
      expect(provider.send).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.arrayContaining([
            expect.objectContaining({
              kind: "instructions",
              text: expect.stringContaining("Octant's built-in Browser"),
            }),
          ]),
        }),
      );
    } finally {
      fixture.close();
    }
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
          options: [{ label: "A" }, { label: "B" }],
        }),
      ),
    );

    await Effect.runPromise(
      Queue.offer(
        queue,
        providerEvent({
          kind: "user-input-request",
          requestId: "question-2",
          prompt: "x".repeat(10_000),
          options: [{ label: "A" }, { label: "B" }],
        }),
      ),
    );

    let frames: readonly OperationFrame[] = [];
    await vi.waitFor(async () => {
      frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20);
      expect(frames.some((frame) => frame.event.kind === "approval-requested")).toBe(true);
      expect(frames.filter((frame) => frame.event.kind === "input-requested")).toHaveLength(2);
    });
    const question = frames.find(
      (frame): frame is OperationFrame & { event: { kind: "input-requested"; prompt: string } } =>
        frame.event.kind === "input-requested" && frame.event.requestId === "question-2",
    );
    expect(question).toBeDefined();
    expect(new TextEncoder().encode(question!.event.prompt).byteLength).toBeLessThanOrEqual(
      8 * 1024,
    );
    expect(question!.event.prompt.length).toBeGreaterThan(2_048);
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
      kind: "answer-provider-input",
      operationId: operationId(14),
      threadId,
      checkoutId,
      requestId: "question-2",
      response: fixture.response,
    });
    expect(connection.answerUserInput).toHaveBeenCalledWith({
      sessionId,
      requestId: "question-2",
      answer: "A",
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

  it("shows the answer choices a provider offers on a question, and none when it offers none", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({ provider: providerDriver(connection) });
    const startOperation = operationId(15);

    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    const offer = (requestId: string, options: ReadonlyArray<Record<string, string>>) =>
      Effect.runPromise(
        Queue.offer(
          queue,
          providerEvent({ kind: "user-input-request", requestId, prompt: "Which one?", options }),
        ),
      );
    await offer("choices", [
      { label: "src/a.ts", description: "The entry point" },
      { label: "src/b.ts" },
    ]);
    await offer("crowded", [
      ...Array.from({ length: 40 }, (_, index) => ({ label: `option-${index}` })),
    ]);
    await offer("long", [{ label: "y".repeat(1_024 * 2) }]);
    await offer("free-text", []);

    let questions: ReadonlyArray<{ readonly requestId: string; readonly options: unknown }> = [];
    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20);
      questions = frames.flatMap((frame) =>
        frame.event.kind === "input-requested" ? [frame.event] : [],
      );
      expect(questions).toHaveLength(4);
    });
    const optionsOf = (requestId: string) =>
      questions.find((question) => question.requestId === requestId)?.options as
        | ReadonlyArray<string>
        | undefined;

    expect(optionsOf("choices")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(optionsOf("crowded")).toHaveLength(32);
    expect(optionsOf("long")?.[0]?.length).toBeLessThanOrEqual(1_024);
    expect(optionsOf("free-text")).toEqual([]);
    await fixture.runtime.close();
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

  it("stops a provider turn whose tool requests were denied for the third time", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      approvalValidator: false,
    });
    const startOperation = operationId(130);

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
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());

    for (const requestId of ["denied-1", "denied-2", "denied-3"])
      await Effect.runPromise(
        Queue.offer(
          queue,
          providerEvent({
            kind: "approval-request",
            requestId,
            action: "write",
            description: `Modify src/${requestId}.ts`,
          }),
        ),
      );

    let approvals: Array<
      OperationFrame & { event: { kind: "approval-requested"; approvalId: string } }
    > = [];
    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 40);
      approvals = frames.filter(
        (
          frame,
        ): frame is OperationFrame & {
          event: { kind: "approval-requested"; approvalId: string };
        } => frame.event.kind === "approval-requested",
      );
      expect(approvals).toHaveLength(3);
    });

    for (const [index, approval] of approvals.slice(0, 2).entries()) {
      await expect(
        fixture.runtime.execute(windowId, {
          kind: "answer-provider-approval",
          operationId: operationId(131 + index),
          threadId,
          checkoutId,
          approvalId: approval.event.approvalId,
          decision: "denied",
        }),
      ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    }
    expect(connection.interrupt).not.toHaveBeenCalled();

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "answer-provider-approval",
        operationId: operationId(133),
        threadId,
        checkoutId,
        approvalId: approvals[2]!.event.approvalId,
        decision: "denied",
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "interrupted" });

    expect(connection.answerApproval).toHaveBeenCalledTimes(3);
    expect(connection.answerApproval).toHaveBeenLastCalledWith({
      sessionId,
      requestId: "denied-3",
      approved: false,
    });
    expect(connection.interrupt).toHaveBeenCalledWith(sessionId);

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 40);
      const terminal = frames.filter(
        (frame) => frame.event.kind === "operation-state" && frame.event.state === "interrupted",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        event: {
          state: "interrupted",
          failure: {
            category: "failed",
            message:
              "Stopped after 3 denied tool requests in one turn. Send a new message to continue.",
          },
        },
      });
    });
    fixture.close();
  });

  it("stops a provider turn whose browser tool requests were denied for the third time", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const provider = providerConnection(queue);
    const authority = decodeToolActionAuthority({
      hostId: "90000000-0000-4000-8000-000000000001",
      mode: "code",
      projectId: thread().projectId,
      rootId: "90000000-0000-4000-8000-000000000009",
      worktreeId: checkoutId,
      providerInstanceId: thread().providerInstanceId,
      extension: { kind: "core" },
    });
    const ready = decodeBrowserAutomationSnapshot({
      status: "ready",
      threadId,
      evidence: [],
    });
    const fixture = runtimeFixture({
      provider: providerDriver(provider),
      browserAutomation: {
        resolveAuthority: () => authority,
        inspectThread: () => ready,
        create: vi.fn(async () => ready),
        act: vi.fn(async () => ready),
        releaseThread: vi.fn(async () => ready),
      },
    });
    const operation = operationId(140);
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: operation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    await vi.waitFor(() => expect(provider.send).toHaveBeenCalledOnce());

    for (const index of [0, 1, 2]) {
      await Effect.runPromise(
        Queue.offer(
          queue,
          providerEvent({
            kind: "tool-request",
            requestId: `browser-${index}`,
            toolName: "octant_browser",
            inputJson: '{"operation":"navigate","url":"https://example.com"}',
          }),
        ),
      );
      let approval: Extract<OperationFrame["event"], { kind: "approval-requested" }> | undefined;
      await vi.waitFor(async () => {
        const frames = await fixture.runtime.subscribe(windowId, threadId, operation, 0, 40);
        approval = frames
          .map((frame) => frame.event)
          .filter((event) => event.kind === "approval-requested")[index];
        expect(approval).toBeDefined();
      });
      if (approval === undefined) throw new Error("Expected browser approval");
      const answer = await fixture.runtime.execute(windowId, {
        kind: "answer-provider-approval",
        operationId: operationId(141 + index),
        threadId,
        checkoutId,
        approvalId: approval.approvalId,
        decision: "denied",
      });
      if (index < 2) {
        expect(answer).toMatchObject({ kind: "provider-turn-state", state: "running" });
        expect(provider.interrupt).not.toHaveBeenCalled();
      } else {
        expect(answer).toMatchObject({ kind: "provider-turn-state", state: "interrupted" });
      }
    }

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, operation, 0, 40);
      const terminal = frames.filter(
        (frame) => frame.event.kind === "operation-state" && frame.event.state === "interrupted",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        event: {
          state: "interrupted",
          failure: {
            category: "failed",
            message:
              "Stopped after 3 denied tool requests in one turn. Send a new message to continue.",
          },
        },
      });
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

  it("journals what changed while a turn ran, before the turn reads as settled", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      gitTreeChanges: [
        { path: "src/app.ts", insertions: 4, deletions: 1, binary: false },
        { path: "../outside.ts", insertions: 1, deletions: 0, binary: false },
      ],
    });
    const startOperation = operationId(27);
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 40);
      const kinds = frames.map((frame) =>
        frame.event.kind === "operation-state" ? `state:${frame.event.state}` : frame.event.kind,
      );
      // A client following the turn has the list by the time the turn settles.
      expect(kinds.indexOf("conversation-turn-changed-files")).toBeGreaterThan(-1);
      expect(kinds.indexOf("conversation-turn-changed-files")).toBeLessThan(
        kinds.indexOf("state:completed"),
      );
      const recorded = frames.find(
        (frame) => frame.event.kind === "conversation-turn-changed-files",
      );
      // The path that leaves the checkout is dropped, and the record says so.
      expect(recorded?.event).toMatchObject({
        changedFiles: {
          files: [{ path: "src/app.ts", insertions: 4, deletions: 1 }],
          total: 2,
          truncated: true,
        },
      });
    });
    fixture.close();
  });

  it("journals a provider turn's completed state once", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({ provider: providerDriver(connection) });
    const startOperation = operationId(150);
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));

    await vi.waitFor(() => expect(fixture.boardActivity()).toMatchObject({ executing: false }));
    const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 40);
    const terminal = frames.filter(
      (frame) => frame.event.kind === "operation-state" && frame.event.state === "completed",
    );
    expect(terminal).toHaveLength(1);
    fixture.close();
  });

  it("journals a provider turn's interruption once, keeping the provider's reason", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({ provider: providerDriver(connection) });
    const startOperation = operationId(151);
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
        providerEvent({ kind: "interrupted", message: "Provider stopped the turn." }),
      ),
    );

    await vi.waitFor(() => expect(fixture.boardActivity()).toMatchObject({ executing: false }));
    const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 40);
    const terminal = frames.filter(
      (frame) => frame.event.kind === "operation-state" && frame.event.state === "interrupted",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      event: {
        state: "interrupted",
        failure: { category: "failed", message: "Provider stopped the turn." },
      },
    });
    fixture.close();
  });

  it("journals a provider turn's failure once, keeping the provider's reason", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({ provider: providerDriver(connection) });
    const startOperation = operationId(152);
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
          failure: { category: "provider-failed", message: "Provider exploded mid-turn." },
        }),
      ),
    );

    await vi.waitFor(() => expect(fixture.boardActivity()).toMatchObject({ executing: false }));
    const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 40);
    const terminal = frames.filter(
      (frame) => frame.event.kind === "operation-state" && frame.event.state === "failed",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      event: {
        state: "failed",
        failure: { category: "failed", message: "Provider exploded mid-turn." },
      },
    });
    fixture.close();
  });

  it("records no change list for a turn whose checkout could not be captured", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({ provider: providerDriver(connection) });
    const startOperation = operationId(28);
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 40);
      expect(
        frames.some(
          (frame) => frame.event.kind === "operation-state" && frame.event.state === "completed",
        ),
      ).toBe(true);
      // No record means "not observed"; an empty one would read as "nothing changed".
      expect(frames.some((frame) => frame.event.kind === "conversation-turn-changed-files")).toBe(
        false,
      );
    });
    fixture.close();
  });

  it("journals how a tool ended so the row it started does not stay open forever", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({ provider: providerDriver(connection) });
    const startOperation = operationId(21);
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
        providerEvent({ kind: "tool-start", toolCallId: "call-1", toolName: "Read" }),
      ),
    );
    await Effect.runPromise(
      Queue.offer(
        queue,
        providerEvent({ kind: "tool-success", toolCallId: "call-1", summary: "Tool completed." }),
      ),
    );

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20);
      const states = frames.flatMap((frame) =>
        frame.event.kind === "tool-activity" ? [frame.event.state] : [],
      );
      expect(states).toEqual(["started", "completed"]);
      const closed = frames.find(
        (frame) => frame.event.kind === "tool-activity" && frame.event.state === "completed",
      );
      expect(closed?.event).toMatchObject({ toolName: "Read", summary: "Tool completed." });
    });
    fixture.close();
  });

  it("journals a tool request whose input exceeds the summary bound as a truncated summary instead of failing the turn", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({ provider: providerDriver(connection) });
    const startOperation = operationId(22);
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
          kind: "tool-request",
          requestId: "large-tool-request",
          toolName: "octant_acp_terminal_create",
          inputJson: JSON.stringify({ command: "x".repeat(6_000) }),
        }),
      ),
    );
    await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 30);
      const started = frames.find(
        (frame) =>
          frame.event.kind === "tool-activity" &&
          (frame.event.state === "started" || frame.event.state === "running"),
      );
      expect(started?.event.kind).toBe("tool-activity");
      if (started?.event.kind !== "tool-activity") return;
      expect(started.event.summary?.endsWith(" [truncated]")).toBe(true);
      expect(new TextEncoder().encode(started.event.summary ?? "").byteLength).toBeLessThanOrEqual(
        MAX_CODE_OPERATION_SUMMARY_BYTES,
      );
      expect(
        frames.some(
          (frame) => frame.event.kind === "operation-state" && frame.event.state === "completed",
        ),
      ).toBe(true);
      expect(
        frames.some(
          (frame) => frame.event.kind === "operation-state" && frame.event.state === "failed",
        ),
      ).toBe(false);
    });
    fixture.close();
  });

  it("preserves provider context occupancy and compaction point and window make-up in live events and replayed conversation usage", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({ provider: providerDriver(connection) });
    const startOperation = operationId(29);
    try {
      await fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: startOperation,
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
      });
      await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
      const usage = {
        kind: "usage" as const,
        inputTokens: 135_224,
        outputTokens: 364,
        contextTokens: 27_600,
        contextWindow: 258_400,
        autoCompactThreshold: 167_000,
        contextBreakdown: {
          parts: [
            { kind: "messages" as const, tokens: 900, accuracy: "provider-reported" as const },
          ],
        },
      };
      await Effect.runPromise(Queue.offer(queue, providerEvent(usage)));
      await vi.waitFor(async () => {
        const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 20);
        expect(frames.find((frame) => frame.event.kind === "usage")?.event).toEqual(usage);
      });
      const page = await fixture.runtime.conversation(windowId, threadId, 0, 20);
      expect(page.turns.find((turn) => turn.operationId === startOperation)?.usage).toEqual({
        inputTokens: 135_224,
        outputTokens: 364,
        contextTokens: 27_600,
        contextWindow: 258_400,
        autoCompactThreshold: 167_000,
        contextBreakdown: usage.contextBreakdown,
      });
    } finally {
      fixture.close();
    }
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
      gitTreeChanges: [{ path: "src/app.ts", insertions: 2, deletions: 0, binary: false }],
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
      const kinds = frames.map((frame) =>
        frame.event.kind === "operation-state" ? `state:${frame.event.state}` : frame.event.kind,
      );
      expect(kinds.indexOf("conversation-turn-changed-files")).toBeGreaterThan(-1);
      expect(kinds.indexOf("conversation-turn-changed-files")).toBeLessThan(
        kinds.indexOf("state:failed"),
      );
    });
    fixture.close();
  });

  it("does not snapshot the checkout to record changes after the thread has become Plan", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection = providerConnection(queue);
    const fixture = runtimeFixture({
      provider: providerDriver(connection),
      gitTreeChanges: [{ path: "src/app.ts", insertions: 1, deletions: 0, binary: false }],
    });
    const startOperation = operationId(32);
    await fixture.runtime.execute(windowId, {
      kind: "start-provider-turn",
      operationId: startOperation,
      threadId,
      checkoutId,
      sessionId,
      prompt: fixture.prompt,
    });
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    fixture.setThread(decodeCodeThread({ ...thread(), executionPolicy: "plan" }));
    await Effect.runPromise(Queue.offer(queue, providerEvent({ kind: "completed" })));

    await vi.waitFor(async () => {
      const frames = await fixture.runtime.subscribe(windowId, threadId, startOperation, 0, 40);
      expect(
        frames.some(
          (frame) => frame.event.kind === "operation-state" && frame.event.state === "completed",
        ),
      ).toBe(true);
      expect(frames.some((frame) => frame.event.kind === "conversation-turn-changed-files")).toBe(
        false,
      );
    });
    expect(fixture.snapshotPolicies).not.toContain("plan");
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

  it.each(["cancel", "shutdown"] as const)(
    "prevents process launch when %s occurs during repository discovery",
    async (action) => {
      const definition = decodeCodeRepositoryTestDefinition({
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
      });
      let releaseDiscovery: () => void = () => undefined;
      const pending = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      const discover = vi.fn(async () => {
        await pending;
        return [definition];
      });
      const execute = vi.fn(async () => ({
        termination: "unavailable" as const,
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        parserFailed: false,
        cleanupUncertain: false,
      }));
      const fixture = runtimeFixture({
        repositoryTestDiscovery: { discover },
        repositoryTestProcessPort: { execute, readArtifact: async () => undefined },
      });
      const testRunId = operationId(80);
      const running = fixture.runtime.execute(windowId, {
        kind: "run-repository-test",
        operationId: operationId(81),
        threadId,
        checkoutId,
        testRunId,
        definition,
      });
      await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
      const shutdown = action === "shutdown" ? fixture.runtime.close() : undefined;
      const cancelled =
        action === "cancel"
          ? await fixture.runtime.execute(windowId, {
              kind: "cancel-repository-test",
              operationId: operationId(82),
              threadId,
              checkoutId,
              testRunId,
            })
          : undefined;
      releaseDiscovery();
      const result = await running;
      await shutdown;
      await fixture.runtime.close();
      if (action === "cancel")
        expect(cancelled).toMatchObject({ kind: "repository-test-state", state: "interrupted" });
      expect(result).toMatchObject({ kind: "repository-test-state", state: "interrupted" });
      expect(execute).not.toHaveBeenCalled();
      fixture.close();
    },
  );

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
      blockingReason: "Octant could not confirm how the last step ended.",
    });
    fixture.close();
  });

  it("leaves a pull request GitHub never confirmed waiting rather than ready", async () => {
    const fixture = runtimeFixture({
      pullRequestTarget: true,
      gitObservation: readyGitObservation([
        {
          name: "origin",
          fetchUrl: "https://github.com/octant/octant.git",
          pushUrl: "https://github.com/octant/octant.git",
        },
      ]),
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

  it("reports a checkout with no GitHub remote instead of blaming GitHub authentication", async () => {
    const ensure = vi.fn(async () => {
      throw new Error("pull request ensure should not run");
    });
    const fixture = runtimeFixture({
      pullRequestTarget: true,
      gitObservation: readyGitObservation([]),
      pullRequestPort: {
        ensure,
        observeReview: async () => ({ status: "unavailable" }),
      },
    });
    const delivery = operationId(110);

    const created = await fixture.runtime.execute(windowId, {
      kind: "create-pull-request",
      operationId: delivery,
      threadId,
      checkoutId,
      title: "Add the board's runtime work",
      body: "Body",
      idempotencyKey: "runtime-work-delivery-no-remote",
      authorization: { kind: "approved", approvalId: operationId(111) },
    });

    expect(created).toMatchObject({
      kind: "pull-request-state",
      state: "unavailable",
      failureCode: "no-remote",
    });
    expect(ensure).not.toHaveBeenCalled();
    fixture.close();
  });

  it("reports a missing GitHub remote instead of an unavailable review when the checkout has no GitHub remote", async () => {
    const observeReview = vi.fn(async () => ({ status: "unavailable" as const }));
    const fixture = runtimeFixture({
      pullRequestTarget: true,
      gitObservation: readyGitObservation([]),
      pullRequestPort: {
        ensure: async () => ({ status: "unavailable" as const }),
        observeReview,
      },
    });
    const review = await fixture.runtime.execute(windowId, {
      kind: "observe-pull-request",
      operationId: operationId(112),
      threadId,
      checkoutId,
      maxDiffBytes: 1024,
    });

    expect(review).toMatchObject({
      kind: "pull-request-review",
      state: "unavailable",
      freshness: "stale",
      failureCode: "no-remote",
    });
    expect(observeReview).not.toHaveBeenCalled();
    fixture.close();
  });

  it.each([
    {
      label: "fetch-only",
      fetchUrl: "https://github.com/octant/octant.git",
      pushUrl: "https://git.example.com/octant/octant.git",
    },
    {
      label: "push-only",
      fetchUrl: "https://git.example.com/octant/octant.git",
      pushUrl: "https://github.com/octant/octant.git",
    },
  ])("accepts a GitHub $label remote for pull request delivery", async (remote) => {
    const ensure = vi.fn(async () => ({
      status: "created" as const,
      pullRequest: {
        number: 11,
        url: "https://github.com/octant/octant/pull/11",
        baseRepository: "octant/octant",
        baseBranch: "development",
        headOwner: "octant",
        headBranch: "feature/runtime",
      },
    }));
    const fixture = runtimeFixture({
      pullRequestTarget: true,
      gitRemotes: [
        {
          name: "origin",
          fetchUrl: remote.fetchUrl,
          pushUrl: remote.pushUrl,
        },
      ],
      pullRequestPort: {
        ensure,
        observeReview: async () => ({ status: "unavailable" }),
      },
    });

    const created = await fixture.runtime.execute(windowId, {
      kind: "create-pull-request",
      operationId: operationId(115),
      threadId,
      checkoutId,
      title: "Add the board's runtime work",
      body: "Body",
      idempotencyKey: `runtime-work-delivery-${remote.label}`,
      authorization: { kind: "approved", approvalId: operationId(116) },
    });

    expect(created).toMatchObject({ kind: "pull-request-state", state: "created" });
    expect(ensure).toHaveBeenCalledOnce();
    fixture.close();
  });

  // The Waiting column exists for exactly this: an effect the host refuses
  // until someone decides. The approved retry carries the same operation, so it
  // continues that record rather than leaving a second one owed forever.
  it("holds delivery waiting until the effect is approved, then continues the same record", async () => {
    let approved = false;
    const fixture = runtimeFixture({
      pullRequestTarget: true,
      gitRemotes: [
        {
          name: "origin",
          fetchUrl: "https://github.com/octant/octant.git",
          pushUrl: "https://github.com/octant/octant.git",
        },
      ],
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
      blockingReason: "Waiting for a decision or answer.",
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

describe("managed Code creation approval", () => {
  const managedCommand = {
    kind: "create-managed-code-thread" as const,
    threadId: decodeCodeThreadId("90000000-0000-4000-8000-000000000009"),
    projectId: thread().projectId,
    bindingRevisionId: thread().bindingRevisionId,
    title: "Managed runtime",
    providerInstanceId: thread().providerInstanceId,
    modelId: thread().modelId,
    executionPolicy: "full-access" as const,
    permissionPersistence: "current-session" as const,
    deliveryTarget: thread().deliveryTarget,
    sourceBranch: "feature/runtime" as never,
    startFromOrigin: true,
    remoteName: "origin",
  };

  it("refuses a managed Full access challenge when the window cannot access the Project", async () => {
    const managedThreadCreation = {
      prepare: vi.fn(),
      commit: vi.fn(),
      cleanup: vi.fn(),
    };
    const fixture = runtimeFixture({
      approvalValidator: false,
      projectAccess: false,
      managedThreadCreation: managedThreadCreation as never,
    });

    await expect(
      fixture.runtime.prepareApproval(windowId, {
        effect: { kind: "create-managed-code-thread-full-access", command: managedCommand },
      }),
    ).resolves.toBeUndefined();
    expect(managedThreadCreation.prepare).not.toHaveBeenCalled();
    fixture.close();
  });

  it("prepares a server-derived source challenge and refuses a stale source", async () => {
    const preparation = {
      repositoryId: thread().repositoryId,
      checkoutId: decodeCodeCheckoutId("90000000-0000-4000-8000-000000000010"),
      branchIntent: "feature/runtime",
      resolvedHead: "b".repeat(40),
      mode: "origin" as const,
      sourceBranch: "feature/runtime",
      remoteName: "origin",
    };
    const managedThreadCreation = {
      prepare: vi.fn(async () => ({ status: "prepared" as const, preparation })),
      commit: vi.fn(),
      cleanup: vi.fn(),
    };
    const fixture = runtimeFixture({
      approvalValidator: false,
      managedThreadCreation: managedThreadCreation as never,
    });
    const request = {
      effect: { kind: "create-managed-code-thread-full-access" as const, command: managedCommand },
    };
    const challenge = await fixture.runtime.prepareApproval(windowId, request);
    expect(challenge).toMatchObject({
      projectId: thread().projectId,
      threadId: managedCommand.threadId,
      checkoutId: preparation.checkoutId,
      checkoutHead: {
        kind: "branch",
        name: preparation.branchIntent,
        oid: preparation.resolvedHead,
      },
      message: "Allow full access for this new Code thread?",
    });
    expect(challenge?.detail).toContain(preparation.branchIntent);
    expect(challenge?.detail).not.toContain(preparation.resolvedHead);
    expect(managedThreadCreation.prepare).toHaveBeenCalledOnce();
    expect(managedThreadCreation.commit).not.toHaveBeenCalled();
    fixture.close();

    const stale = runtimeFixture({
      approvalValidator: false,
      managedThreadCreation: {
        prepare: vi.fn(async () => ({
          status: "prepared" as const,
          preparation: { ...preparation, resolvedHead: "c".repeat(40) },
        })),
        commit: vi.fn(),
        cleanup: vi.fn(),
      } as never,
    });
    await expect(
      stale.runtime.prepareApproval(windowId, {
        effect: {
          ...request.effect,
          source: {
            bindingRevisionId: managedCommand.bindingRevisionId,
            repositoryId: preparation.repositoryId,
            checkoutId: preparation.checkoutId,
            checkoutHead: {
              kind: "branch",
              name: preparation.branchIntent as never,
              oid: preparation.resolvedHead,
            },
          },
        },
      }),
    ).resolves.toBeUndefined();
    stale.close();
  });
});

function runtimeFixture(options: {
  provider?: ProviderDriver | undefined;
  browserAutomation?: Parameters<typeof createCodeOperationRuntime>[0]["browserAutomation"];
  computerUseTools?: Parameters<typeof createCodeOperationRuntime>[0]["computerUseTools"];
  resolveSelectedExtensions?: Parameters<
    typeof createCodeOperationRuntime
  >[0]["resolveSelectedExtensions"];
  computerUseUnattachedTools?: Parameters<
    typeof createCodeOperationRuntime
  >[0]["computerUseUnattachedTools"];
  /** Whether the thread's provider can carry app-managed tools (default true). */
  supportsAppManagedTools?: boolean;
  /** Whether the provider natively serves ACP client capabilities. */
  supportsAcpClientCapabilities?: boolean;
  /** Whether the provider can carry a session on to another of its models. */
  supportsModelSwitch?: boolean;
  terminalExit?: { readonly exitCode: number };
  pullRequestPort?: Parameters<typeof createCodeOperationRuntime>[0]["pullRequestPort"];
  pullRequestTarget?: boolean;
  repositoryTestDiscovery?: Parameters<
    typeof createCodeOperationRuntime
  >[0]["repositoryTestDiscovery"];
  repositoryTestProcessPort?: Parameters<
    typeof createCodeOperationRuntime
  >[0]["repositoryTestProcessPort"];
  credential?: string | undefined;
  credentialResolver?: Parameters<typeof createCodeOperationRuntime>[0]["credentialResolver"];
  credentialReferences?: readonly { environmentName: string; reference: string }[];
  gitObservation?: GitObservationResult;
  gitRemotes?: ReadonlyArray<{
    readonly name: string;
    readonly fetchUrl: string;
    readonly pushUrl: string;
  }>;
  gitReadDiff?: (
    input: Parameters<GitObservationPort["readDiff"]>[0],
  ) => Promise<GitScopedDiffResult>;
  /**
   * What differs between a turn's starting capture and the checkout when it
   * settles. Setting it also lets the checkout be captured; left out, the
   * checkout cannot be read and a turn carries no checkpoint.
   */
  gitTreeChanges?: ReadonlyArray<{
    path: string;
    insertions: number;
    deletions: number;
    binary: boolean;
  }>;
  approvalValidator?: boolean | (() => boolean);
  projectAccess?: boolean;
  managedThreadCreation?: Parameters<typeof createCodeOperationRuntime>[0]["managedThreadCreation"];
  failRuntimeWorkJournal?: boolean;
  throwRuntimeWorkReporter?: boolean;
  onProviderTurnRequested?: (threadId: CodeThreadId) => void;
  probeProvider?: Parameters<typeof createCodeOperationRuntime>[0]["probeProvider"];
  readonly resolveProviderDriver?: Parameters<
    typeof createCodeOperationRuntime
  >[0]["resolveProviderDriver"];
  isProviderModelAllowed?: (thread: CodeThread) => boolean;
  spendCeiling?: Parameters<typeof createCodeOperationRuntime>[0]["spendCeiling"];
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
      .register(CODE_RUNTIME_WORK_UPDATED, 1, CodeRuntimeWorkUpdated)
      .register("feedback.note-captured@1", 1, ProductFeedbackCaptured)
      .register("feedback.note-delivered@1", 1, ProductFeedbackDelivered),
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(new CodeProjection())
      .register(new ProductFeedbackProjection()),
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
  const snapshotPolicies: Array<string | undefined> = [];
  const checkout = decodeCodeCheckoutIdentity({
    id: checkoutId,
    repositoryId: activeThread.repositoryId,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "feature/runtime", oid: "a".repeat(40) },
    observedAt: now,
  });
  const access = vi.fn(async () => options.projectAccess ?? true);
  const prompt = evidence(40);
  const response = evidence(41);
  const evidenceValues = new Map([
    [prompt.contentId, "Implement this."],
    [response.contentId, "A"],
  ]);
  let evidenceCounter = 50;
  let uuidCounter = 100;
  const feedbackCrop = `data:image/png;base64,${Buffer.from("captured image").toString("base64")}`;
  const feedback = new ProductFeedbackService({
    journal,
    browser: {
      describePoint: async () => ({
        status: "described",
        element: {
          selector: "button",
          bounds: { x: 0.2, y: 0.4, width: 0.2, height: 0.2 },
        },
        cropDataUrl: feedbackCrop,
      }),
    },
    crops: { put: (content) => storedEvidence(45, content), read: () => feedbackCrop },
    readNote: (id) => readProductFeedbackNote(connection, id),
    readNotes: (id) => readProductFeedbackNotes(connection, id),
    canAccessThread: access,
    uuid: () => String(operationId(++uuidCounter)),
    clock: () => now,
    actor,
  });
  const runtimeWorkFailures: string[] = [];
  let exitTerminal: (() => void) | undefined;
  const runtime = createCodeOperationRuntime({
    persistence: {
      journal,
      readCodeRuntimeWorkAggregateVersion: (id) =>
        readCodeRuntimeWorkAggregateVersion(connection, id),
      readCodeThread: (id) => (id === threadId ? activeThread : undefined),
      readCodeCheckout: (id) => (id === checkoutId ? checkout : undefined),
      readReviewFinding: () => undefined,
      readReviewFindings: () => [],
    },
    ...(options.probeProvider === undefined ? {} : { probeProvider: options.probeProvider }),
    windowAccess: { canAccessProject: access },
    resolveCheckoutRoot: async () => ({
      checkoutRoot: "/private/exact",
      shell: "/bin/zsh",
      credentialReferences: options.credentialReferences ?? [],
      environment: {},
    }),
    resolveProviderDriver: options.resolveProviderDriver ?? (async () => options.provider),
    ...(options.computerUseTools === undefined
      ? {}
      : { computerUseTools: options.computerUseTools }),
    ...(options.resolveSelectedExtensions === undefined
      ? {}
      : { resolveSelectedExtensions: options.resolveSelectedExtensions }),
    ...(options.computerUseUnattachedTools === undefined
      ? {}
      : { computerUseUnattachedTools: options.computerUseUnattachedTools }),
    ...(options.browserAutomation === undefined &&
    options.supportsAppManagedTools === undefined &&
    options.supportsAcpClientCapabilities === undefined
      ? {}
      : {
          ...(options.browserAutomation === undefined
            ? {}
            : {
                browserAutomation: options.browserAutomation,
                supportsAppManagedTools: () => options.supportsAppManagedTools ?? true,
              }),
          ...(options.supportsAppManagedTools === undefined
            ? {}
            : { supportsAppManagedTools: () => options.supportsAppManagedTools ?? false }),
          ...(options.supportsAcpClientCapabilities === undefined
            ? {}
            : {
                supportsAcpClientCapabilities: () => options.supportsAcpClientCapabilities ?? false,
              }),
        }),
    ...(options.supportsModelSwitch === undefined
      ? {}
      : { supportsModelSwitch: () => options.supportsModelSwitch ?? false }),
    credentialResolver: options.credentialResolver ?? { resolve: async () => options.credential },
    supportsAttachments: () => true,
    takeProductFeedbackForTurn: createProductFeedbackTurnPort({ service: feedback }),
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
    ...(options.managedThreadCreation === undefined
      ? {}
      : { managedThreadCreation: options.managedThreadCreation }),
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
    ...(options.onProviderTurnRequested === undefined
      ? {}
      : { onProviderTurnRequested: options.onProviderTurnRequested }),
    ...(options.isProviderModelAllowed === undefined
      ? {}
      : { isProviderModelAllowed: options.isProviderModelAllowed }),
    ...(options.spendCeiling === undefined ? {} : { spendCeiling: options.spendCeiling }),
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
    ...(options.repositoryTestDiscovery === undefined
      ? {}
      : { repositoryTestDiscovery: options.repositoryTestDiscovery }),
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
      observeRemotes: async () => options.gitRemotes ?? [],
      ...(options.gitReadDiff === undefined ? {} : { readDiff: options.gitReadDiff }),
      ...(options.gitTreeChanges === undefined
        ? {}
        : {
            readTreeChanges: async () => ({
              status: "ready" as const,
              changes: options.gitTreeChanges ?? [],
            }),
          }),
    },
    gitMutationPort: {
      stage: async () => ({ status: "failed" as const }),
      unstage: async () => ({ status: "failed" as const }),
      commit: async () => ({ status: "failed" as const }),
      push: async () => ({ status: "failed" as const }),
      discard: async () => ({ status: "failed" as const }),
      revertCommit: async () => ({ status: "failed" as const }),
      snapshotWorkingTree: async (input: { readonly executionPolicy?: string }) => {
        snapshotPolicies.push(input.executionPolicy);
        return options.gitTreeChanges === undefined
          ? { status: "failed" as const }
          : {
              status: "captured" as const,
              snapshot: { worktree: "d".repeat(40), index: "e".repeat(40) },
              anchorId: "3f1b0c9a-5d42-4e77-9a1c-6b2e8f0d4c31",
            };
      },
      restoreWorkingTree: async () => ({ status: "failed" as const }),
      releaseCheckpoint: async () => {},
    },
  });
  return {
    runtime,
    feedback,
    access,
    prompt,
    response,
    evidenceValues,
    setThread: (next: CodeThread) => {
      activeThread = next;
    },
    snapshotPolicies,
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
    /**
     * The store the service writes a turn's opening frame through, so a test
     * can put a prior turn on the journal the runtime reads.
     */
    operationEvents: new CodeOperationEventStore({
      journal,
      uuid: () => `90000000-0000-4000-8000-${(++uuidCounter).toString().padStart(12, "0")}`,
      clock: () => now,
      actor,
    }),
    close: () => connection.close(),
  };
}

function providerConnection(
  queue: Queue.Queue<ProviderRuntimeEvent>,
  starts: Array<ProviderSessionStart> = [],
): ProviderConnection {
  return {
    subscribe: Effect.succeed(Stream.fromQueue(queue)),
    start: vi.fn((input) => {
      starts.push(input);
      return Effect.succeed<ProviderSessionHandle>({
        sessionId,
        resumeCursor: { driverKind: "codex", value: "native-code-session" },
      });
    }),
    resume: vi.fn((input) =>
      Effect.succeed({ sessionId: input.sessionId, resumeCursor: input.resumeCursor }),
    ),
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

function readyGitObservation(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly fetchUrl: string;
    readonly pushUrl: string;
  }>,
): GitObservationResult {
  return {
    status: "ready",
    checkoutRoot: "/private/exact",
    head: { kind: "branch", name: "feature/runtime", oid: "a".repeat(40) },
    statusEntries: [],
    changedPaths: [],
    insertions: 0,
    deletions: 0,
    stagedSummary: [],
    diff: { text: "", byteLength: 0, truncated: false },
    remotes,
    upstream: null,
    worktrees: [],
    stateToken: "b".repeat(64),
  };
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
it("names why a turn whose provider cannot carry an app-managed tool was refused", async () => {
  const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const provider = providerConnection(queue);
  const authority = decodeToolActionAuthority({
    hostId: "90000000-0000-4000-8000-000000000010",
    mode: "code",
    projectId: thread().projectId,
    rootId: "90000000-0000-4000-8000-000000000009",
    worktreeId: checkoutId,
    providerInstanceId: thread().providerInstanceId,
    extension: { kind: "core" },
  });
  const browserSnapshot = decodeBrowserAutomationSnapshot({
    status: "ready",
    threadId,
    evidence: [],
  });
  const fixture = runtimeFixture({
    provider: providerDriver(provider),
    supportsAppManagedTools: false,
    browserAutomation: {
      resolveAuthority: () => authority,
      inspectThread: () => browserSnapshot,
      create: async () => browserSnapshot,
      act: async () => browserSnapshot,
      releaseThread: async () => browserSnapshot,
    },
  });
  try {
    // A refusal the person can act on: without the sentence, the composer
    // could only say "The provider turn could not be started."
    await expect(
      fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(76),
        threadId,
        checkoutId,
        sessionId,
        prompt: fixture.prompt,
        extensionSelections: [browserUseSelection("code-browser-refusal")],
      }),
    ).resolves.toMatchObject({
      kind: "provider-turn-state",
      state: "failed",
      failure: {
        category: "failed",
        message:
          "This provider cannot carry Octant's Browser tool. Check the provider's connection in Settings, then retry without the Browser selection.",
      },
    });
  } finally {
    fixture.close();
  }
});

it("lets a follow-up open a fresh provider session when a refused turn never reached one", async () => {
  const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const connection = providerConnection(queue);
  const fixture = runtimeFixture({ provider: providerDriver(connection) });
  try {
    // The record the service leaves for a send a later check refused: the turn
    // began on the journal, its refusal settled, and no provider session ever
    // answered it.
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(90),
      expectedCursor: 0,
      event: decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: thread().providerInstanceId,
        modelId: thread().modelId,
        sessionId,
        prompt: fixture.prompt,
      }),
    });
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(90),
      expectedCursor: 1,
      event: decodeCodeOperationEvent({
        kind: "operation-result",
        result: {
          kind: "provider-turn-state",
          operationId: operationId(90),
          state: "failed",
          failure: { category: "failed", message: "refused" },
        },
      }),
    });
    await expect(
      fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(91),
        threadId,
        checkoutId,
        sessionId: decodeProviderSessionId("90000000-0000-4000-8000-000000000091"),
        prompt: fixture.prompt,
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    await vi.waitFor(() => expect(connection.start).toHaveBeenCalledOnce());
    expect(connection.resume).not.toHaveBeenCalled();
  } finally {
    await fixture.runtime.close();
    fixture.close();
  }
});

it("refuses a fresh start while an interrupted prior turn still owns an unseen prompt", async () => {
  const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const connection = providerConnection(queue);
  const fixture = runtimeFixture({ provider: providerDriver(connection) });
  try {
    // The record a host exit between the `running` result and the launch
    // leaves: the prompt is journaled, the provider never saw it, and the
    // original operation's own retry is still the only honest recovery.
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(92),
      expectedCursor: 0,
      event: decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: thread().providerInstanceId,
        modelId: thread().modelId,
        sessionId,
        prompt: fixture.prompt,
      }),
    });
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(92),
      expectedCursor: 1,
      event: decodeCodeOperationEvent({
        kind: "operation-result",
        result: { kind: "provider-turn-state", operationId: operationId(92), state: "running" },
      }),
    });
    await expect(
      fixture.runtime.execute(windowId, {
        kind: "start-provider-turn",
        operationId: operationId(93),
        threadId,
        checkoutId,
        sessionId: decodeProviderSessionId("90000000-0000-4000-8000-000000000093"),
        prompt: fixture.prompt,
      }),
    ).resolves.toMatchObject({
      kind: "provider-turn-state",
      state: "failed",
      failure: {
        message:
          "The task's previous turn stopped before the provider started. Retry that message, or start a new task.",
      },
    });
    expect(connection.start).not.toHaveBeenCalled();
    expect(connection.resume).not.toHaveBeenCalled();
  } finally {
    await fixture.runtime.close();
    fixture.close();
  }
});

it("settles an answer to an approval a host exit left waiting as interrupted", async () => {
  const fixture = runtimeFixture({});
  try {
    // The record a host exit mid-approval leaves: the request is journaled and
    // the turn reads waiting, but the provider session that would consume the
    // answer died with the process, so the card can never be delivered.
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(94),
      expectedCursor: 0,
      event: decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: thread().providerInstanceId,
        modelId: thread().modelId,
        sessionId,
        prompt: fixture.prompt,
      }),
    });
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(94),
      expectedCursor: 1,
      event: decodeCodeOperationEvent({
        kind: "approval-requested",
        approvalId: "90000000-0000-4000-8000-000000000094",
        action: "provider-tool",
        summary: "command: Approval is required for this action.",
      }),
    });
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(94),
      expectedCursor: 2,
      event: decodeCodeOperationEvent({ kind: "operation-state", state: "waiting" }),
    });

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "answer-provider-approval",
        operationId: operationId(95),
        threadId,
        checkoutId,
        approvalId: "90000000-0000-4000-8000-000000000094",
        decision: "approved",
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "interrupted" });

    const replay = fixture.operationEvents.replay({
      threadId,
      operationId: operationId(94),
      afterCursor: 0,
      limit: 10,
    });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames.at(-1)?.event).toMatchObject({
      kind: "operation-state",
      state: "interrupted",
    });
  } finally {
    fixture.close();
  }
});

it("settles an answer to a provider question a host exit left waiting as interrupted", async () => {
  const fixture = runtimeFixture({});
  try {
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(96),
      expectedCursor: 0,
      event: decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: thread().providerInstanceId,
        modelId: thread().modelId,
        sessionId,
        prompt: fixture.prompt,
      }),
    });
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(96),
      expectedCursor: 1,
      event: decodeCodeOperationEvent({
        kind: "input-requested",
        requestId: "provider-question-1",
        prompt: "Which file?",
        options: ["src/a.ts", "src/b.ts"],
      }),
    });
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(96),
      expectedCursor: 2,
      event: decodeCodeOperationEvent({ kind: "operation-state", state: "waiting" }),
    });

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "answer-provider-input",
        operationId: operationId(97),
        threadId,
        checkoutId,
        requestId: "provider-question-1",
        response: fixture.response,
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "interrupted" });

    const replay = fixture.operationEvents.replay({
      threadId,
      operationId: operationId(96),
      afterCursor: 0,
      limit: 10,
    });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames.at(-1)?.event).toMatchObject({
      kind: "operation-state",
      state: "interrupted",
    });
  } finally {
    fixture.close();
  }
});

it("refuses a repeated answer to a request whose turn already settled", async () => {
  const fixture = runtimeFixture({});
  try {
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(98),
      expectedCursor: 0,
      event: decodeCodeOperationEvent({
        kind: "conversation-turn-started",
        providerInstanceId: thread().providerInstanceId,
        modelId: thread().modelId,
        sessionId,
        prompt: fixture.prompt,
      }),
    });
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(98),
      expectedCursor: 1,
      event: decodeCodeOperationEvent({
        kind: "approval-requested",
        approvalId: "90000000-0000-4000-8000-000000000098",
        action: "provider-tool",
        summary: "command: Approval is required for this action.",
      }),
    });
    fixture.operationEvents.append({
      threadId,
      operationId: operationId(98),
      expectedCursor: 2,
      event: decodeCodeOperationEvent({ kind: "operation-state", state: "interrupted" }),
    });

    await expect(
      fixture.runtime.execute(windowId, {
        kind: "answer-provider-approval",
        operationId: operationId(99),
        threadId,
        checkoutId,
        approvalId: "90000000-0000-4000-8000-000000000098",
        decision: "approved",
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "failed" });

    const replay = fixture.operationEvents.replay({
      threadId,
      operationId: operationId(98),
      afterCursor: 0,
      limit: 10,
    });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames).toHaveLength(3);
  } finally {
    fixture.close();
  }
});

it("passes only ACP client tools when native ACP capability support is enabled", async () => {
  const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const starts: Array<ProviderSessionStart> = [];
  const provider = providerDriver(providerConnection(queue, starts));
  const fixture = runtimeFixture({
    provider,
    supportsAppManagedTools: false,
    supportsAcpClientCapabilities: true,
  });

  await fixture.runtime.execute(windowId, {
    kind: "start-provider-turn",
    operationId: operationId(77),
    threadId,
    checkoutId,
    sessionId,
    prompt: fixture.prompt,
  });

  expect(starts[0]?.tools?.map((tool) => tool.name)).toEqual([
    "octant_acp_fs_read_text_file",
    "octant_acp_fs_write_text_file",
    "octant_acp_terminal_create",
    "octant_acp_terminal_output",
    "octant_acp_terminal_wait_for_exit",
    "octant_acp_terminal_kill",
    "octant_acp_terminal_release",
  ]);
  fixture.close();
});

it("omits app-managed tools when neither bridge nor native ACP support is enabled", async () => {
  const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const starts: Array<ProviderSessionStart> = [];
  const provider = providerDriver(providerConnection(queue, starts));
  const fixture = runtimeFixture({
    provider,
    supportsAppManagedTools: false,
    supportsAcpClientCapabilities: false,
  });

  await fixture.runtime.execute(windowId, {
    kind: "start-provider-turn",
    operationId: operationId(78),
    threadId,
    checkoutId,
    sessionId,
    prompt: fixture.prompt,
  });

  expect(starts[0]?.tools).toEqual([]);
  fixture.close();
});

it("does not include ACP client tools when only bridge support is enabled", async () => {
  const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const starts: Array<ProviderSessionStart> = [];
  const provider = providerDriver(providerConnection(queue, starts));
  const fixture = runtimeFixture({
    provider,
    supportsAppManagedTools: true,
    supportsAcpClientCapabilities: false,
  });

  await fixture.runtime.execute(windowId, {
    kind: "start-provider-turn",
    operationId: operationId(79),
    threadId,
    checkoutId,
    sessionId,
    prompt: fixture.prompt,
  });

  expect(starts[0]?.tools?.some((tool) => tool.name.startsWith("octant_acp_"))).toBeFalsy();
  fixture.close();
});

it("registers a refusal-only Computer tool on a turn that carried no Computer selection", async () => {
  const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const starts: Array<ProviderSessionStart> = [];
  const provider = providerDriver(providerConnection(queue, starts));
  const unattachedCalls: string[] = [];
  const fixture = runtimeFixture({
    provider,
    supportsAppManagedTools: true,
    computerUseUnattachedTools: () => {
      unattachedCalls.push("called");
      return {
        definitions: [
          {
            name: "octant_computer",
            description: "Not attached to this turn.",
            inputSchema: { type: "object" },
          },
        ],
        execute: async () => ({
          result: {
            error: "computer-use-not-attached",
            message: "Tell the user to add @Computer and send again.",
          },
          isError: true,
        }),
      };
    },
  });

  await fixture.runtime.execute(windowId, {
    kind: "start-provider-turn",
    operationId: operationId(80),
    threadId,
    checkoutId,
    sessionId,
    prompt: fixture.prompt,
  });

  expect(unattachedCalls).toHaveLength(1);
  expect(starts[0]?.tools?.map((tool) => tool.name)).toContain("octant_computer");
  fixture.close();
});

it("keeps the selected Computer tool instead of the refusal stub when @Computer is attached", async () => {
  const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const starts: Array<ProviderSessionStart> = [];
  const provider = providerDriver(providerConnection(queue, starts));
  const unattachedCalls: string[] = [];
  const fixture = runtimeFixture({
    provider,
    supportsAppManagedTools: true,
    computerUseTools: () => ({
      definitions: [
        {
          name: "octant_computer",
          description: "The real tool.",
          inputSchema: { type: "object" },
        },
      ],
      execute: async () => ({ result: { kind: "apps", apps: [] } }),
    }),
    computerUseUnattachedTools: () => {
      unattachedCalls.push("called");
      return undefined;
    },
  });

  await fixture.runtime.execute(windowId, {
    kind: "start-provider-turn",
    operationId: operationId(81),
    threadId,
    checkoutId,
    sessionId,
    prompt: fixture.prompt,
    computerUseSelection: computerUseSelection("selected"),
  });

  expect(unattachedCalls).toHaveLength(0);
  expect(starts[0]?.tools?.map((tool) => tool.name)).toContain("octant_computer");
  fixture.close();
});

it("offers a selected MCP server's tools to the Code provider", async () => {
  const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const starts: Array<ProviderSessionStart> = [];
  const provider = providerDriver(providerConnection(queue, starts));
  const fixture = runtimeFixture({
    provider,
    supportsAppManagedTools: true,
    resolveSelectedExtensions: async () => ({
      kind: "resolved",
      context: [],
      tools: {
        definitions: [{ name: "notes_search", inputSchema: { type: "object" } }],
        execute: async () => ({ result: "framed notes" }),
      },
    }),
  });

  await fixture.runtime.execute(windowId, {
    kind: "start-provider-turn",
    operationId: operationId(82),
    threadId,
    checkoutId,
    sessionId,
    prompt: fixture.prompt,
    extensionSelections: [
      {
        kind: "plugin",
        extensionId: "94000000-0000-4000-8000-000000000011",
        packageId: "94000000-0000-4000-8000-000000000012",
        componentId: "notes-server",
        packageVersion: "1.0.0",
        packageDigest: `sha256:${"a".repeat(64)}`,
        catalogEpoch: `sha256:${"b".repeat(64)}`,
        origin: { kind: "draft", reference: "notes" },
      },
    ],
  });

  expect(starts[0]?.tools?.map((tool) => tool.name)).toContain("notes_search");
  fixture.close();
});
