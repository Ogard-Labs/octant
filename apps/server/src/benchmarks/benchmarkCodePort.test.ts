import { decodeProjectId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  createBenchmarkCodePort,
  type BenchmarkCodeRouteService,
  type BenchmarkCodeTurnInput,
} from "./benchmarkCodePort";
import { CodeServiceError } from "../code/codeService";

const projectId = decodeProjectId("66400000-0000-4000-8000-000000000001");
const head = "a".repeat(40);
const thread = "66700000-0000-4000-8000-000000000001";
const submission = "66700000-0000-4000-8000-000000000002";
const checkoutId = "66700000-0000-4000-8000-000000000003";

function input(overrides: Partial<BenchmarkCodeTurnInput> = {}): BenchmarkCodeTurnInput {
  return {
    threadId: thread,
    title: "Suite · Case · model-a",
    codeProjectId: projectId,
    ref: "main",
    branch: "benchmark/66100000/662000000001",
    providerInstanceId: "66700000-0000-4000-8000-0000000000b1" as never,
    modelId: "model-a" as never,
    prompt: "Fix it.",
    submissionId: submission,
    executionPolicy: "auto-accept-edits",
    autoApprove: false,
    ...overrides,
  };
}

function setup(
  options: { readonly refs?: ReadonlyArray<string>; readonly startError?: unknown } = {},
) {
  const known = new Set(options.refs ?? ["refs/heads/main"]);
  const threads = new Map<string, { version: number; checkoutId: string; lifecycle: string }>();
  const commands: Array<Record<string, unknown>> = [];
  const operations: Array<Record<string, unknown>> = [];
  const evidence: string[] = [];
  let approval = false;
  const turn = {
    operationId: "",
    status: "incomplete" as string,
    assistant: [{ contentId: "c1" }, { contentId: "c2" }],
    changedFiles: undefined as
      | {
          files: ReadonlyArray<{ path: string; insertions: number; deletions: number }>;
          total: number;
        }
      | undefined,
    failure: undefined as { message: string } | undefined,
  };
  const code: BenchmarkCodeRouteService = {
    execute: async (_window, command) => {
      commands.push(command as never);
      if (command.kind === "prepare-code-project-checkout") {
        return {
          kind: "checkout-prepared",
          bindingRevisionId: "66700000-0000-4000-8000-0000000000c1",
          checkout: { repositoryId: `repo_${"b".repeat(64)}` },
        } as never;
      }
      if (command.kind === "preview-code-worktree-source") {
        return {
          kind: "worktree-source-previewed",
          preview: known.has(command.refIntent)
            ? { kind: "local", branch: command.refIntent, resolvedHead: head }
            : { kind: "failed", reason: "ref-unavailable" },
        } as never;
      }
      if (command.kind === "create-managed-code-thread") {
        threads.set(String(command.threadId), { version: 1, checkoutId, lifecycle: "active" });
        return { kind: "managed-thread-created" } as never;
      }
      if (command.kind === "change-code-thread-lifecycle") {
        threads.get(String(command.threadId))!.lifecycle = command.lifecycle;
        return { kind: "thread-lifecycle-changed" } as never;
      }
      throw new Error(`unexpected ${command.kind}`);
    },
    executeOperation: async (_window, command) => {
      operations.push(command as never);
      if (options.startError !== undefined) throw options.startError;
      if (command.kind === "start-provider-turn") turn.operationId = String(command.operationId);
      return {
        kind: "provider-turn-state",
        operationId: command.operationId,
        state: "running",
      } as never;
    },
    conversation: async () =>
      ({
        turns: turn.operationId === "" ? [] : [turn],
        nextCursor: 1,
        hasMore: false,
      }) as never,
    readOperationContent: async (_window, _thread, _operation, contentId) => ({
      bytes: new TextEncoder().encode(contentId === "c1" ? "Fixed " : "it."),
    }),
  };
  const port = createBenchmarkCodePort({
    code,
    windowId: "66700000-0000-4000-8000-0000000000d1" as never,
    readThread: (id) => threads.get(id),
    awaitsPerson: () => approval,
    pendingApproval: () => ({
      since: "2026-11-07T09:50:00.000Z",
      summary: "Run ls in the worktree",
    }),
    evidence: {
      put: (text) => {
        evidence.push(text);
        return {
          contentId: "66700000-0000-4000-8000-0000000000e1",
          digest: "c".repeat(64),
          byteLength: text.length,
        } as never;
      },
    },
    clock: () => "2026-11-07T10:00:00.000Z",
    resolveRoot: async () => "/worktrees/cell",
    removeWorktree: async () => "removed",
  });
  return {
    port,
    commands,
    operations,
    evidence,
    turn,
    threads,
    setApproval: (value: boolean) => {
      approval = value;
    },
  };
}

describe("benchmark Code port", () => {
  it("creates a managed thread pinned to the ref's commit, local only, then starts one turn at the thread's level", async () => {
    const { port, commands, operations, evidence } = setup();

    const started = await port.startTurn(input());

    expect(started).toEqual({ status: "started", turnId: submission });
    const create = commands.find((command) => command.kind === "create-managed-code-thread")!;
    expect(create).toMatchObject({
      threadId: thread,
      executionPolicy: "auto-accept-edits",
      sourceRevision: head,
      startFromOrigin: false,
      deliveryTarget: {
        branchIntent: "benchmark/66100000/662000000001",
        outcomeKind: "local-implementation",
      },
    });
    expect(evidence).toEqual(["Fix it."]);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      kind: "start-provider-turn",
      operationId: submission,
      checkoutId,
      executionPolicy: "auto-accept-edits",
    });
  });

  it("does not create a second thread when the cell is started again", async () => {
    const { port, commands } = setup();
    await port.startTurn(input());
    await port.startTurn(input());
    expect(
      commands.filter((command) => command.kind === "create-managed-code-thread"),
    ).toHaveLength(1);
  });

  it("finds a tag when the bare name is not a branch", async () => {
    const { port, commands } = setup({ refs: ["refs/tags/v1"] });
    expect((await port.startTurn(input({ ref: "v1" }))).status).toBe("started");
    const refs = commands
      .filter((command) => command.kind === "preview-code-worktree-source")
      .map((command) => command.refIntent);
    expect(refs).toEqual(["refs/heads/v1", "refs/tags/v1"]);
  });

  it("refuses with a sentence when the ref does not resolve, and creates nothing", async () => {
    const { port, commands } = setup();
    const outcome = await port.startTurn(input({ ref: "nope" }));
    expect(outcome).toMatchObject({ status: "refused" });
    expect(outcome.status === "refused" && outcome.message).toContain('The ref "nope"');
    expect(commands.some((command) => command.kind === "create-managed-code-thread")).toBe(false);
    expect(await port.checkRef(projectId, "nope")).toMatchObject({ status: "refused" });
    expect(await port.checkRef(projectId, "main")).toEqual({ status: "ok", commit: head });
  });

  it("starts from the pinned commit without reading the ref again, so a branch that moved changes nothing", async () => {
    const { port, commands } = setup();
    const pinned = "c".repeat(40);

    expect((await port.startTurn(input({ commit: pinned }))).status).toBe("started");

    expect(commands.some((command) => command.kind === "preview-code-worktree-source")).toBe(false);
    expect(commands.find((command) => command.kind === "create-managed-code-thread")).toMatchObject(
      {
        sourceRevision: pinned,
      },
    );
  });

  it("leaves a cell queued when Code has no room yet", async () => {
    const waiting = new CodeServiceError({
      category: "waiting",
      message: "Provider capacity is full.",
    });
    const { port } = setup({ startError: waiting });
    expect(await port.startTurn(input())).toEqual({
      status: "waiting",
      message: "Provider capacity is full.",
    });
  });

  it("reports a turn parked on an approval, and reads back its reply and a capped diff summary", async () => {
    const { port, turn, setApproval } = setup();
    await port.startTurn(input());

    setApproval(true);
    expect(await port.readTurn(thread, submission)).toMatchObject({
      state: "in-flight",
      awaitingApproval: true,
      waitingSince: "2026-11-07T09:50:00.000Z",
      approvalSummary: "Run ls in the worktree",
    });

    setApproval(false);
    turn.status = "completed";
    turn.changedFiles = {
      files: Array.from({ length: 32 }, (_, index) => ({
        path: `f${index}`,
        insertions: 1,
        deletions: 0,
      })),
      total: 140,
    };
    expect(await port.readTurn(thread, submission)).toMatchObject({
      state: "completed",
      awaitingApproval: false,
    });
    const result = await port.readResult(thread, submission);
    expect(result.reply).toBe("Fixed it.");
    expect(result.diff?.total).toBe(140);
    expect(result.diff?.files).toHaveLength(32);
  });

  it("interrupts only the cell's own operation", async () => {
    const { port, operations } = setup();
    await port.startTurn(input());
    await port.interruptTurn(thread, submission);
    expect(operations.at(-1)).toMatchObject({
      kind: "cancel-provider-turn",
      operationId: submission,
    });
  });

  it("archives a settled cell's thread once", async () => {
    const { port, commands } = setup();
    await port.startTurn(input());
    await port.archiveThread(thread);
    await port.archiveThread(thread);
    expect(
      commands.filter((command) => command.kind === "change-code-thread-lifecycle"),
    ).toHaveLength(1);
  });
});
