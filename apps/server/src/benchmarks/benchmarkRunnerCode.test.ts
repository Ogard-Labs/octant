import {
  decodeBenchmarkRun,
  decodeBenchmarkSuite,
  type BenchmarkRun,
  type PermissionMode,
} from "@octant/contracts";
import type { BenchmarkCommandOutcome } from "@octant/domain";
import { afterEach, describe, expect, it } from "vitest";
import type { BenchmarkChatPort, BenchmarkTurnInput } from "./benchmarkChatPort";
import { BENCHMARKS_PROJECT_ID } from "./benchmarkChatPort";
import type { BenchmarkCheckCommandPort } from "./benchmarkCheckCommand";
import type {
  BenchmarkCodePort,
  BenchmarkCodeResult,
  BenchmarkCodeTurnInput,
  BenchmarkCodeTurnReading,
} from "./benchmarkCodePort";
import { createWorkerPatternMatcher } from "./benchmarkPatternMatcher";
import { BenchmarkRunner, benchmarkCellIdentity } from "./benchmarkRunner";
import {
  BENCHMARK_TEST_NOW,
  benchmarkIds,
  openBenchmarkTestStore,
  removeBenchmarkTestStores,
  sampleRun,
} from "./benchmarkTestSupport";

afterEach(removeBenchmarkTestStores);

const codeProjectId = "66400000-0000-4000-8000-000000000001";

function codeSuite(checks: ReadonlyArray<unknown>) {
  return decodeBenchmarkSuite({
    suiteId: benchmarkIds.suite,
    revision: 1,
    name: "Code smoke",
    cases: [
      {
        caseId: benchmarkIds.caseA,
        kind: "code",
        title: "Fix the bug",
        prompt: "Fix the failing test.",
        checks,
        code: { codeProjectId, ref: "main" },
      },
    ],
    createdAt: BENCHMARK_TEST_NOW,
    updatedAt: BENCHMARK_TEST_NOW,
  });
}

class FakeCode implements BenchmarkCodePort {
  readonly starts: BenchmarkCodeTurnInput[] = [];
  readonly threads = new Set<string>();
  readonly interrupted: string[] = [];
  readonly archived: string[] = [];
  turn: BenchmarkCodeTurnReading & { status: "turn" } = {
    status: "turn",
    turnId: "turn",
    state: "in-flight",
    awaitingApproval: false,
  };
  result: BenchmarkCodeResult = { reply: "Fixed it.", diff: undefined };
  root: string | undefined = "/worktrees/cell";

  async checkRef() {
    return { status: "ok", commit: "a".repeat(40) } as const;
  }
  async startTurn(input: BenchmarkCodeTurnInput) {
    this.starts.push(input);
    this.threads.add(input.threadId);
    return { status: "started", turnId: input.submissionId } as const;
  }
  async readTurn() {
    return this.turn;
  }
  async readResult() {
    return this.result;
  }
  async interruptTurn(threadId: string) {
    this.interrupted.push(threadId);
  }
  async archiveThread(threadId: string) {
    this.archived.push(threadId);
  }
  async worktreeRoot() {
    return this.root;
  }
  async removeWorktree() {
    return "removed" as const;
  }
}

class FakeCommand implements BenchmarkCheckCommandPort {
  readonly runs: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
  outcome: BenchmarkCommandOutcome = { status: "exited", exitCode: 0, output: "" };
  async run(input: { command: string; cwd: string; timeoutMs: number }) {
    this.runs.push({ command: input.command, cwd: input.cwd, timeoutMs: input.timeoutMs });
    return this.outcome;
  }
}

class StubChat implements BenchmarkChatPort {
  readonly starts: BenchmarkTurnInput[] = [];
  async startTurn(input: BenchmarkTurnInput) {
    this.starts.push(input);
    return { status: "started", turnId: "66500000-0000-4000-8000-000000000001" } as const;
  }
  readTurn(threadId: string) {
    return this.starts.some((start) => start.threadId === threadId)
      ? ({ status: "turn", turnId: "judge-turn", outcome: "streaming" } as const)
      : ({ status: "gone" } as const);
  }
  readAnswer() {
    return undefined;
  }
  async interruptTurn() {}
  async archiveThread() {}
}

function setup(
  options: {
    readonly checks?: ReadonlyArray<unknown>;
    readonly projectMode?: PermissionMode | undefined;
    readonly executionLevel?: BenchmarkRun["executionLevel"];
    readonly judge?: boolean;
    readonly repetitions?: number;
    readonly commit?: string;
  } = {},
) {
  const clock = { now: BENCHMARK_TEST_NOW };
  const opened = openBenchmarkTestStore(() => clock.now);
  const code = new FakeCode();
  const command = new FakeCommand();
  const chat = new StubChat();
  const make = () =>
    new BenchmarkRunner({
      chat,
      code,
      checkCommand: command,
      projectMode: () => ("projectMode" in options ? options.projectMode : "ask-first"),
      projection: opened.projection,
      store: opened.store,
      turnMetrics: { forThread: () => [] },
      projectId: BENCHMARKS_PROJECT_ID,
      matchPattern: createWorkerPatternMatcher(300),
      clock: () => clock.now,
    });
  const base = sampleRun({
    suite: codeSuite(options.checks ?? []),
    ...(options.repetitions === undefined ? {} : { repetitions: options.repetitions }),
    ...(options.judge === true
      ? { judge: { providerInstanceId: benchmarkIds.judgeProvider, modelId: "judge-model" } }
      : {}),
  });
  const run = decodeBenchmarkRun({
    ...base,
    ...(options.executionLevel === undefined ? {} : { executionLevel: options.executionLevel }),
    ...(options.commit === undefined
      ? {}
      : { codeCommits: [{ caseId: benchmarkIds.caseA, commit: options.commit }] }),
  });
  opened.store.runStarted({ run });
  const cell = () => opened.projection.run(benchmarkIds.run)!.cells[0]!;
  const advance = (ms: number) => {
    clock.now = new Date(Date.parse(clock.now) + ms).toISOString();
  };
  return { ...opened, code, command, chat, runner: make(), make, cell, advance, run };
}

/** Lets the background checks finish, then the pass that settles the cell. */
async function settle(runner: BenchmarkRunner) {
  await runner.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runner.tick();
}

describe("benchmark Code cells", () => {
  it("creates a managed thread from the case's ref and starts one turn at the level the Project allows", async () => {
    const { runner, code, cell, run } = setup({ executionLevel: "auto", projectMode: "ask-first" });

    await runner.tick();

    expect(code.starts).toHaveLength(1);
    const cellId = String(cell().cellId);
    expect(code.starts[0]).toMatchObject({
      threadId: benchmarkCellIdentity(cellId).threadId,
      submissionId: benchmarkCellIdentity(cellId).submissionId,
      ref: "main",
      codeProjectId,
      // Auto was asked for, the Project asks first, so the thread asks first.
      executionPolicy: "approval-gated",
      autoApprove: false,
      branch: `benchmark/${String(run.runId).replace(/-/g, "").slice(0, 8)}/${cellId.replace(/-/g, "").slice(0, 12)}`,
    });
    expect(cell().state).toBe("running");
    expect(cell().threadId).toBe(benchmarkCellIdentity(cellId).threadId);
  });

  it("starts every cell of a case from the commit the run pinned", async () => {
    const pinned = "d".repeat(40);
    const { runner, code, advance } = setup({ repetitions: 2, commit: pinned });
    await runner.tick();
    // The branch moves between the cells; the run's own answer does not.
    advance(1_000);
    code.turn = { ...code.turn, state: "completed" };
    await settle(runner);
    await runner.tick();
    expect(code.starts.length).toBeGreaterThanOrEqual(2);
    expect(code.starts.map((start) => start.commit)).toEqual(code.starts.map(() => pinned));
  });

  it("resolves the ref per cell on an older run that pinned nothing", async () => {
    const { runner, code } = setup();
    await runner.tick();
    expect(code.starts[0]?.commit).toBeUndefined();
  });

  it("keeps the level the run asked for when the Project holds it", async () => {
    const { runner, code } = setup({ executionLevel: "accept-edits", projectMode: "accept-edits" });
    await runner.tick();
    expect(code.starts[0]).toMatchObject({ executionPolicy: "auto-accept-edits" });
  });

  it("fails the cell with a sentence when the Code Project is gone", async () => {
    const { runner, code, cell } = setup({ projectMode: undefined });
    await runner.tick();
    expect(code.starts).toHaveLength(0);
    expect(cell()).toMatchObject({
      state: "failed",
      failureReason: "The Code Project is gone or is no longer a Code Project.",
    });
  });

  it("does not start a second turn for a cell it already started, even after a restart", async () => {
    const { runner, make, code } = setup();
    await runner.tick();
    await make().tick();
    await runner.tick();
    expect(code.starts).toHaveLength(1);
    expect(code.threads.size).toBe(1);
  });

  it("ends a cell as blocked-on-approval, and interrupts the turn, after ten minutes on an approval", async () => {
    const { runner, code, cell, advance } = setup();
    await runner.tick();
    code.turn = { ...code.turn, awaitingApproval: true };

    await runner.tick();
    advance(9 * 60_000);
    await runner.tick();
    expect(cell().state).toBe("running");

    advance(60_000);
    await runner.tick();

    expect(cell().state).toBe("blocked-on-approval");
    expect(code.interrupted).toEqual([benchmarkCellIdentity(String(cell().cellId)).threadId]);
    expect(code.archived).toHaveLength(1);
  });

  it("counts a wait from when the journal says it began, so a restart grants no new ten minutes", async () => {
    const { runner, make, code, cell, advance } = setup();
    await runner.tick();
    const askedAt = new Date(Date.parse(BENCHMARK_TEST_NOW) - 9 * 60_000).toISOString();
    code.turn = { ...code.turn, awaitingApproval: true, waitingSince: askedAt };
    advance(30_000);
    const restarted = make();

    await restarted.tick();
    expect(cell().state).toBe("running");

    advance(30_000);
    await restarted.tick();

    expect(cell().state).toBe("blocked-on-approval");
  });

  it("counts from the cell's start when a restarted runner first meets a turn already parked and nothing dates the wait", async () => {
    const { runner, make, code, cell, advance } = setup();
    await runner.tick();
    advance(10 * 60_000);
    code.turn = { ...code.turn, awaitingApproval: true };

    await make().tick();

    expect(cell().state).toBe("blocked-on-approval");
  });

  it("starts the approval clock again when the approval is answered", async () => {
    const { runner, code, cell, advance } = setup();
    await runner.tick();
    code.turn = { ...code.turn, awaitingApproval: true };
    await runner.tick();
    advance(9 * 60_000);
    code.turn = { ...code.turn, awaitingApproval: false };
    await runner.tick();
    code.turn = { ...code.turn, awaitingApproval: true };
    advance(2 * 60_000);
    await runner.tick();
    advance(2 * 60_000);
    await runner.tick();
    expect(cell().state).toBe("running");
    expect(code.interrupted).toHaveLength(0);
  });

  it("runs the checks in the cell's worktree once the turn is answered and scores them in the case's order", async () => {
    const { runner, code, command, cell } = setup({
      checks: [
        { kind: "command-exits-zero", command: "bun test", timeoutSeconds: 120 },
        { kind: "max-files-changed", count: 1 },
        { kind: "contains", text: "fixed", caseSensitive: false },
      ],
    });
    await runner.tick();
    code.turn = { ...code.turn, state: "completed" };
    code.result = {
      reply: "Fixed it.",
      diff: {
        files: [
          { path: "a.ts", insertions: 1, deletions: 0 },
          { path: "b.ts", insertions: 2, deletions: 2 },
        ],
        total: 2,
      },
    };

    await settle(runner);

    expect(command.runs).toEqual([
      { command: "bun test", cwd: "/worktrees/cell", timeoutMs: 120_000 },
    ]);
    expect(cell().state).toBe("answered");
    expect(cell().checks).toEqual([
      { index: 0, passed: true },
      { index: 1, passed: false, detail: "2 files changed, more than 1" },
      { index: 2, passed: true },
    ]);
    expect(code.archived).toHaveLength(1);
  });

  it("gives a command at most ten minutes whatever the case allows", async () => {
    const { runner, code, command } = setup({
      checks: [{ kind: "command-exits-zero", command: "bun test", timeoutSeconds: 600 }],
    });
    await runner.tick();
    code.turn = { ...code.turn, state: "completed" };
    await settle(runner);
    expect(command.runs[0]?.timeoutMs).toBe(600_000);
  });

  it("fails a check whose command timed out and says so", async () => {
    const { runner, code, command, cell } = setup({
      checks: [{ kind: "command-exits-zero", command: "sleep 999", timeoutSeconds: 1 }],
    });
    await runner.tick();
    code.turn = { ...code.turn, state: "completed" };
    command.outcome = { status: "timed-out", output: "" };

    await settle(runner);

    expect(cell().state).toBe("answered");
    expect(cell().checks).toEqual([{ index: 0, passed: false, detail: "timed out" }]);
  });

  it("keeps at most 200 characters of a failing command's output", async () => {
    const { runner, code, command, cell } = setup({
      checks: [{ kind: "command-exits-zero", command: "bun test", timeoutSeconds: 60 }],
    });
    await runner.tick();
    code.turn = { ...code.turn, state: "completed" };
    command.outcome = { status: "exited", exitCode: 1, output: "e".repeat(100_000) };

    await settle(runner);

    const detail = cell().checks[0]?.detail ?? "";
    expect(cell().checks[0]?.passed).toBe(false);
    expect(detail.startsWith("exit 1: eee")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(200);
  });

  it("fails a command check, without running it, when the worktree is gone", async () => {
    const { runner, code, command, cell } = setup({
      checks: [{ kind: "command-exits-zero", command: "bun test", timeoutSeconds: 60 }],
    });
    await runner.tick();
    code.turn = { ...code.turn, state: "completed" };
    code.root = undefined;

    await settle(runner);

    expect(command.runs).toHaveLength(0);
    expect(cell().checks[0]).toMatchObject({
      passed: false,
      detail: "The cell's worktree is not available.",
    });
  });

  it("fails the cell with the turn's own reason when the turn fails", async () => {
    const { runner, code, cell } = setup();
    await runner.tick();
    code.turn = { ...code.turn, state: "failed", failureMessage: "Provider refused." };
    await runner.tick();
    expect(cell()).toMatchObject({ state: "failed", failureReason: "Provider refused." });
  });

  it("gives the judge the diff summary and the check results, never the reply or the contender", async () => {
    const { runner, code, chat, cell } = setup({
      judge: true,
      checks: [{ kind: "max-files-changed", count: 5 }],
    });
    await runner.tick();
    code.turn = { ...code.turn, state: "completed" };
    code.result = {
      reply: "SECRET CLOSING TEXT",
      diff: { files: [{ path: "src/x.ts", insertions: 3, deletions: 1 }], total: 1 },
    };
    await settle(runner);
    expect(cell().state).toBe("answered");

    await runner.tick();

    expect(chat.starts).toHaveLength(1);
    const prompt = chat.starts[0]!.prompt;
    expect(prompt).toContain("src/x.ts +3 -1");
    expect(prompt).toContain("passed: at most 5 files changed");
    expect(prompt).not.toContain("SECRET CLOSING TEXT");
    expect(prompt).not.toMatch(/model-a/);
  });

  it("interrupts a Code turn and stops its checks when the run is cancelled", async () => {
    const { runner, code, cell } = setup();
    await runner.tick();

    await runner.cancel(benchmarkIds.run);

    expect(cell().state).toBe("cancelled");
    expect(code.interrupted).toHaveLength(1);
    expect(code.archived).toHaveLength(1);
  });
});
