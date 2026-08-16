import { describe, expect, it, vi } from "vitest";
import type { AutomationRun, WorkThreadId, UtcTimestamp, WindowId } from "@octant/contracts";
import { decodeWorkThreadId } from "@octant/contracts/work-threads";
import { WorkTurnServiceError } from "../work/workTurnService";
import {
  createAutomationWorkDispatchPort,
  type AutomationWorkRouteService,
  type AutomationWorkTurnService,
} from "./automationWorkDispatchPort";
import { unavailableAutomationWorkDispatchPort } from "./automationModeDispatchPorts";
import {
  AUTOMATION_TEST_IDS,
  automationDefinitionFixture,
  automationRunForDefinition,
} from "./automationTestFixtures";

const windowId = "00000000-0000-4000-8000-000000000601" as WindowId;
const threadId = decodeWorkThreadId("aa000000-0000-4000-8000-0000000000d0");
const now = "2026-08-10T13:00:20.000Z" as UtcTimestamp;

function workRun(): AutomationRun {
  const definition = automationDefinitionFixture();
  return automationRunForDefinition(definition, {
    id: AUTOMATION_TEST_IDS.run,
    at: now,
  });
}

function createThreads(
  overrides: Partial<AutomationWorkRouteService> = {},
): AutomationWorkRouteService {
  return {
    bootstrap: vi.fn(async () => ({
      threads: [] as ReadonlyArray<{ readonly id: WorkThreadId }>,
    })),
    execute: vi.fn(async () => ({
      kind: "thread-created",
      thread: { id: threadId },
    })),
    ...overrides,
  };
}

function createTurns(
  overrides: Partial<AutomationWorkTurnService> = {},
): AutomationWorkTurnService {
  return {
    startFirstTurn: vi.fn(async () => ({
      kind: "accepted" as const,
      turn: {
        requestId: AUTOMATION_TEST_IDS.firstTurnRequest,
        status: "running",
      },
    })),
    ...overrides,
  };
}

describe("createAutomationWorkDispatchPort", () => {
  it("creates a Work thread from the definition snapshot and reuses the dispatcher thread id", async () => {
    const threads = createThreads();
    const port = createAutomationWorkDispatchPort({
      threads,
      turns: createTurns(),
      clock: () => now,
      uuid: () => "aa000000-0000-4000-8000-0000000000e0",
    });
    const run = workRun();

    const outcome = await port.createThread({
      run,
      threadId,
      title: "Weekly summary",
      windowId,
    });

    expect(port.available).toBe(true);
    expect(outcome).toEqual({ kind: "created", threadId, createdAt: now });
    expect(threads.execute).toHaveBeenCalledWith(windowId, {
      kind: "create-work-thread",
      threadId,
      projectId: run.definitionSnapshot.projectId,
      title: "Weekly summary",
      providerInstanceId: run.definitionSnapshot.executionProfile.providerInstanceId,
      modelId: run.definitionSnapshot.executionProfile.modelId,
      hostId: "local",
      bindingRevisionId:
        run.definitionSnapshot.binding.kind === "work"
          ? run.definitionSnapshot.binding.bindingRevisionId
          : undefined,
      workingDirectory: ".",
    });
  });

  it("returns existing when the deterministic Work thread is already present", async () => {
    const threads = createThreads({
      bootstrap: vi.fn(async () => ({ threads: [{ id: threadId }] })),
      execute: vi.fn(async () => {
        throw new Error("should not create");
      }),
    });
    const port = createAutomationWorkDispatchPort({
      threads,
      turns: createTurns(),
      clock: () => now,
      uuid: () => "aa000000-0000-4000-8000-0000000000e0",
    });

    const outcome = await port.createThread({
      run: workRun(),
      threadId,
      title: "Weekly summary",
      windowId,
    });

    expect(outcome).toEqual({ kind: "existing", threadId });
    expect(threads.execute).not.toHaveBeenCalled();
  });

  it("maps thread creation failures to typed unavailable/unauthorized/conflict reasons", async () => {
    const threads = createThreads({
      execute: vi.fn(async () => {
        throw new Error("Work thread host is not authorized.");
      }),
    });
    const port = createAutomationWorkDispatchPort({
      threads,
      turns: createTurns(),
      clock: () => now,
      uuid: () => "aa000000-0000-4000-8000-0000000000e0",
    });

    await expect(
      port.createThread({
        run: workRun(),
        threadId,
        title: "Weekly summary",
        windowId,
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      reason: "unauthorized",
    });
  });

  it("starts the first Work turn with the immutable task prompt and snapshot authority", async () => {
    const turns = createTurns();
    const port = createAutomationWorkDispatchPort({
      threads: createThreads(),
      turns,
      clock: () => now,
      uuid: () => "aa000000-0000-4000-8000-0000000000e0",
    });
    const run = workRun();

    const outcome = await port.startOrRecoverFirstTurn({
      run,
      threadId,
      firstTurnRequestId: run.firstTurnRequestId,
      promptDigest: "unused" as never,
      windowId,
    });

    expect(outcome).toEqual({
      kind: "accepted",
      runtimeReceipt: `work-turn:${String(run.firstTurnRequestId)}`,
      acceptedAt: now,
    });
    expect(turns.startFirstTurn).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({
        kind: "start-work-thread-turn",
        requestId: run.firstTurnRequestId,
        threadId,
        prompt: run.definitionSnapshot.taskPrompt,
        authority: expect.objectContaining({
          hostId: "local",
          projectId: run.definitionSnapshot.projectId,
          bindingRevisionId:
            run.definitionSnapshot.binding.kind === "work"
              ? run.definitionSnapshot.binding.bindingRevisionId
              : undefined,
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: run.definitionSnapshot.executionProfile.providerInstanceId,
          modelId: run.definitionSnapshot.executionProfile.modelId,
        }),
      }),
    );
  });

  it("is idempotent on firstTurnRequestId by returning the existing accepted turn", async () => {
    const turns = createTurns({
      startFirstTurn: vi.fn(async () => ({
        kind: "accepted" as const,
        turn: {
          requestId: AUTOMATION_TEST_IDS.firstTurnRequest,
          status: "completed",
        },
      })),
    });
    const port = createAutomationWorkDispatchPort({
      threads: createThreads(),
      turns,
      clock: () => now,
      uuid: () => "aa000000-0000-4000-8000-0000000000e0",
    });
    const run = workRun();

    const first = await port.startOrRecoverFirstTurn({
      run,
      threadId,
      firstTurnRequestId: run.firstTurnRequestId,
      promptDigest: "unused" as never,
      windowId,
    });
    const second = await port.startOrRecoverFirstTurn({
      run,
      threadId,
      firstTurnRequestId: run.firstTurnRequestId,
      promptDigest: "unused" as never,
      windowId,
    });

    expect(first.kind).toBe("accepted");
    expect(second.kind).toBe("accepted");
    expect(turns.startFirstTurn).toHaveBeenCalledTimes(2);
  });

  it("maps provider capacity waits without accepting a first turn", async () => {
    const turns = createTurns({
      startFirstTurn: vi.fn(async () => {
        throw new WorkTurnServiceError({
          category: "unavailable",
          message: "Provider capacity is unavailable for this Work turn.",
        });
      }),
    });
    const port = createAutomationWorkDispatchPort({
      threads: createThreads(),
      turns,
      clock: () => now,
      uuid: () => "aa000000-0000-4000-8000-0000000000e0",
    });
    const run = workRun();

    await expect(
      port.startOrRecoverFirstTurn({
        run,
        threadId,
        firstTurnRequestId: run.firstTurnRequestId,
        promptDigest: "unused" as never,
        windowId,
      }),
    ).resolves.toEqual({
      kind: "waiting-capacity",
      message: "Provider capacity is unavailable for this Work turn.",
    });
  });

  it("maps first-turn launch failures", async () => {
    const turns = createTurns({
      startFirstTurn: vi.fn(async () => {
        throw new WorkTurnServiceError({
          category: "failed",
          message: "Provider rejected the Work turn.",
        });
      }),
    });
    const port = createAutomationWorkDispatchPort({
      threads: createThreads(),
      turns,
      clock: () => now,
      uuid: () => "aa000000-0000-4000-8000-0000000000e0",
    });
    const run = workRun();

    await expect(
      port.startOrRecoverFirstTurn({
        run,
        threadId,
        firstTurnRequestId: run.firstTurnRequestId,
        promptDigest: "unused" as never,
        windowId,
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      reason: "provider-launch-failed",
    });
  });
});

describe("unavailableAutomationWorkDispatchPort", () => {
  it("stays unavailable and fails closed for create and first-turn", async () => {
    const port = unavailableAutomationWorkDispatchPort("Work gated for tests.");
    expect(port.available).toBe(false);
    expect(port.unavailableReason).toBe("Work gated for tests.");
    await expect(
      port.createThread({
        run: workRun(),
        threadId,
        title: "Weekly summary",
        windowId,
      }),
    ).resolves.toMatchObject({ kind: "failed", reason: "unavailable" });
    await expect(
      port.startOrRecoverFirstTurn({
        run: workRun(),
        threadId,
        firstTurnRequestId: workRun().firstTurnRequestId,
        promptDigest: "unused" as never,
        windowId,
      }),
    ).resolves.toMatchObject({ kind: "failed", reason: "provider-launch-failed" });
  });
});
