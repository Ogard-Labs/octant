import {
  decodeBenchmarkRunStartRequest,
  decodeBenchmarkSuite,
  type BenchmarkRunStartRequest,
  type PermissionMode,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { benchmarkCellIdentity } from "./benchmarkRunner";
import { BenchmarkService } from "./benchmarkService";
import {
  BENCHMARK_TEST_NOW,
  benchmarkIds,
  openBenchmarkTestStore,
  removeBenchmarkTestStores,
} from "./benchmarkTestSupport";

afterEach(removeBenchmarkTestStores);

const codeProjectId = "66400000-0000-4000-8000-000000000001";

function suite() {
  return decodeBenchmarkSuite({
    suiteId: benchmarkIds.suite,
    revision: 1,
    name: "Code smoke",
    cases: [
      {
        caseId: benchmarkIds.caseA,
        kind: "code",
        title: "Fix the bug",
        prompt: "Fix it.",
        checks: [],
        code: { codeProjectId, ref: "main" },
      },
    ],
    createdAt: BENCHMARK_TEST_NOW,
    updatedAt: BENCHMARK_TEST_NOW,
  });
}

function setup(
  options: {
    readonly mode?: PermissionMode | undefined;
    readonly ref?:
      | { readonly status: "ok" }
      | { readonly status: "refused"; readonly message: string };
    readonly removal?:
      | "removed"
      | "absent"
      | { readonly status: "refused"; readonly message: string };
    readonly supported?: boolean;
  } = {},
) {
  const opened = openBenchmarkTestStore();
  opened.store.suiteSaved({ suite: suite() });
  const purged: Array<[string, string]> = [];
  const removed: string[] = [];
  const service = new BenchmarkService({
    projection: opened.projection,
    store: opened.store,
    turnMetrics: { forThread: () => [] },
    runner: { cancel: async (runId) => opened.projection.run(runId), kick: () => undefined },
    contenderAvailable: () => true,
    ensureProject: async () => ({ status: "ready" }),
    purgeThread: async (threadId, mode) => {
      purged.push([threadId, mode]);
      return "purged";
    },
    ...(options.supported === false
      ? {}
      : {
          codeCases: {
            projectMode: () => ("mode" in options ? options.mode : "ask-first"),
            checkRef: async () => options.ref ?? { status: "ok" },
            removeWorktree: async (threadId: string) => {
              removed.push(threadId);
              return options.removal ?? "removed";
            },
          },
        }),
    clock: () => BENCHMARK_TEST_NOW,
    uuid: opened.uuid,
  });
  return { ...opened, service, purged, removed };
}

const windowId = "66300000-0000-4000-8000-000000000001" as never;

function request(executionLevel?: BenchmarkRunStartRequest["executionLevel"]) {
  return decodeBenchmarkRunStartRequest({
    runId: benchmarkIds.run,
    suiteId: benchmarkIds.suite,
    contenders: [{ providerInstanceId: benchmarkIds.providerA, modelId: "model-a" }],
    repetitions: 1,
    budget: { maxTokens: 1_000 },
    ...(executionLevel === undefined ? {} : { executionLevel }),
  });
}

describe("starting a run with Code cases", () => {
  it("refuses Full access for a Project that does not already allow it, before any cell runs", async () => {
    const { service, projection } = setup({ mode: "accept-edits" });
    const outcome = await service.startRun(windowId, request("full-access"));
    expect(outcome).toMatchObject({ status: "refused", reason: "invalid" });
    expect(outcome.status === "refused" && outcome.message).toMatch(/Full access is not allowed/);
    expect(projection.runs()).toHaveLength(0);
  });

  it("starts a run at Full access where the Project already allows it", async () => {
    const { service } = setup({ mode: "full-access" });
    expect((await service.startRun(windowId, request("full-access"))).status).toBe("ok");
  });

  it("refuses a Code case whose Project is missing or is not a Code Project", async () => {
    const { service, projection } = setup({ mode: undefined });
    const outcome = await service.startRun(windowId, request());
    expect(outcome).toMatchObject({ status: "refused", reason: "invalid" });
    expect(outcome.status === "refused" && outcome.message).toContain("Fix the bug");
    expect(projection.runs()).toHaveLength(0);
  });

  it("refuses a run whose ref does not resolve, with the reason as a sentence", async () => {
    const { service, projection } = setup({
      ref: {
        status: "refused",
        message: 'The ref "main" cannot be used: that ref does not exist.',
      },
    });
    const outcome = await service.startRun(windowId, request());
    expect(outcome).toMatchObject({ status: "refused", reason: "invalid" });
    expect(outcome.status === "refused" && outcome.message).toContain("that ref does not exist");
    expect(projection.runs()).toHaveLength(0);
  });

  it("refuses Code cases on a host that cannot run them", async () => {
    const { service } = setup({ supported: false });
    expect(await service.startRun(windowId, request())).toMatchObject({
      status: "refused",
      reason: "unavailable",
    });
  });
});

describe("purging a run with Code cells", () => {
  async function finishedRun(ctx: ReturnType<typeof setup>) {
    const started = await ctx.service.startRun(windowId, request());
    if (started.status !== "ok") throw new Error("start refused");
    ctx.store.runEnded({
      runId: started.value.runId,
      status: "finished",
      endedAt: BENCHMARK_TEST_NOW as never,
    });
    return started.value;
  }

  it("removes each cell's worktree, then purges its Code thread, and forgets the run", async () => {
    const ctx = setup();
    const run = await finishedRun(ctx);
    const threadId = benchmarkCellIdentity(String(run.cells[0]!.cellId)).threadId;

    const outcome = await ctx.service.purgeRun({ runId: run.runId });

    expect(outcome.status).toBe("ok");
    expect(ctx.removed).toEqual([threadId]);
    expect(ctx.purged).toContainEqual([threadId, "code"]);
    expect(ctx.projection.run(String(run.runId))).toBeUndefined();
  });

  it("counts a worktree that is already gone as done", async () => {
    const ctx = setup({ removal: "absent" });
    const run = await finishedRun(ctx);
    expect((await ctx.service.purgeRun({ runId: run.runId })).status).toBe("ok");
  });

  it("keeps the run, with the reason, when the worktree cleanup refuses", async () => {
    const ctx = setup({
      removal: { status: "refused", message: "it still holds uncommitted changes." },
    });
    const run = await finishedRun(ctx);

    const outcome = await ctx.service.purgeRun({ runId: run.runId });

    expect(outcome).toMatchObject({ status: "refused", reason: "unavailable" });
    expect(outcome.status === "refused" && outcome.message).toContain("uncommitted changes");
    expect(ctx.projection.run(String(run.runId))).toBeDefined();
    expect(ctx.purged).toHaveLength(0);
  });
});
