import { BENCHMARK_ROUTE_PATHS } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { benchmarkCellIdentity, benchmarkJudgeIdentity } from "./benchmarkRunner";
import { createBenchmarkRouteHandler } from "./benchmarkRoutes";
import { BenchmarkService } from "./benchmarkService";
import {
  BENCHMARK_TEST_NOW,
  benchmarkIds,
  openBenchmarkTestStore,
  removeBenchmarkTestStores,
  sampleRun,
  sampleSuite,
} from "./benchmarkTestSupport";

afterEach(removeBenchmarkTestStores);

const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const windowId = "66500000-0000-4000-8000-000000000001";

function setup(
  options: { readonly available?: boolean; readonly purge?: "purged" | "absent" | "failed" } = {},
) {
  const opened = openBenchmarkTestStore();
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now: Date.now() });
  const kicks: number[] = [];
  const purged: string[] = [];
  const service = new BenchmarkService({
    projection: opened.projection,
    store: opened.store,
    turnMetrics: { forThread: () => [] },
    runner: {
      cancel: async (runId) => opened.projection.run(runId),
      kick: () => void kicks.push(1),
    },
    contenderAvailable: () => options.available ?? true,
    ensureProject: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: "ready" };
    },
    purgeThread: async (threadId) => {
      purged.push(threadId);
      return options.purge ?? "purged";
    },
    clock: () => BENCHMARK_TEST_NOW,
    uuid: opened.uuid,
  });
  const handler = createBenchmarkRouteHandler({
    windowAuthorityStore,
    service,
    now: () => Date.now(),
  });
  return { ...opened, handler, kicks, purged };
}

function post(path: string, body: unknown, options: { readonly remote?: boolean } = {}): Request {
  const request = new Request(`http://127.0.0.1:3100${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-octant-window-capability": capability },
    body: JSON.stringify(body),
  });
  if (options.remote === true) {
    bindPrincipalRouteContext(request, {
      principal: createRemoteDevicePrincipal({
        hostId: "11111111-1111-4111-8111-111111111111" as never,
        deviceId: "22222222-2222-4222-8222-222222222222" as never,
        credentialGeneration: 1,
        origin: "https://octant.example",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "33333333-3333-4333-8333-333333333333" as never,
      }),
      scopeId: windowId as never,
    });
  }
  return request;
}

const saveBody = {
  suiteId: benchmarkIds.suite,
  name: "Smoke",
  cases: sampleSuite().cases,
};
const startBody = {
  runId: benchmarkIds.run,
  suiteId: benchmarkIds.suite,
  contenders: [{ providerInstanceId: benchmarkIds.providerA, modelId: "model-a" }],
  repetitions: 1,
  budget: { maxTokens: 10_000 },
};

describe("benchmark routes", () => {
  it("lets a local window save a suite, start a run on it, and read both back", async () => {
    const { handler, kicks } = setup();
    const saved = await handler(post(BENCHMARK_ROUTE_PATHS.suitesSave, saveBody));
    expect(saved?.status).toBe(200);
    const started = await handler(post(BENCHMARK_ROUTE_PATHS.runsStart, startBody));
    expect(started?.status).toBe(200);
    expect(kicks).toHaveLength(1);
    const listed = await handler(post(BENCHMARK_ROUTE_PATHS.runsList, {}));
    const body = (await listed!.json()) as { runs: Array<{ cellCount: number; status: string }> };
    expect(body.runs).toMatchObject([{ cellCount: 2, status: "running" }]);
    const read = await handler(post(BENCHMARK_ROUTE_PATHS.runsRead, { runId: benchmarkIds.run }));
    const detail = (await read!.json()) as { run: { cells: unknown[] }; leaderboard: unknown[] };
    expect(detail.run.cells).toHaveLength(2);
    expect(detail.leaderboard).toHaveLength(1);
  });

  for (const [name, path, body] of [
    ["saving a suite", BENCHMARK_ROUTE_PATHS.suitesSave, saveBody],
    ["deleting a suite", BENCHMARK_ROUTE_PATHS.suitesDelete, { suiteId: benchmarkIds.suite }],
    ["starting a run", BENCHMARK_ROUTE_PATHS.runsStart, startBody],
    ["cancelling a run", BENCHMARK_ROUTE_PATHS.runsCancel, { runId: benchmarkIds.run }],
    ["purging a run", BENCHMARK_ROUTE_PATHS.runsPurge, { runId: benchmarkIds.run }],
  ] as const) {
    it(`refuses a remote device ${name} and journals nothing`, async () => {
      const { handler, projection } = setup();
      const response = await handler(post(path, body, { remote: true }));
      expect(response?.status).toBe(403);
      expect(projection.suites()).toEqual([]);
      expect(projection.runs()).toEqual([]);
    });
  }

  it("lets a remote device read suites and runs", async () => {
    const { handler, store } = setup();
    store.suiteSaved({ suite: sampleSuite() });
    store.runStarted({ run: sampleRun() });
    const suites = await handler(post(BENCHMARK_ROUTE_PATHS.suitesList, {}, { remote: true }));
    expect(suites?.status).toBe(200);
    expect(((await suites!.json()) as { suites: unknown[] }).suites).toHaveLength(1);
    const read = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsRead, { runId: benchmarkIds.run }, { remote: true }),
    );
    expect(read?.status).toBe(200);
  });

  it("refuses a request without a window capability", async () => {
    const { handler } = setup();
    const request = new Request(`http://127.0.0.1:3100${BENCHMARK_ROUTE_PATHS.suitesList}`, {
      method: "POST",
      body: "{}",
    });
    expect((await handler(request))?.status).toBe(401);
  });

  it("refuses a start for a suite that does not exist", async () => {
    const { handler } = setup();
    const response = await handler(post(BENCHMARK_ROUTE_PATHS.runsStart, startBody));
    expect(response?.status).toBe(404);
  });

  it("refuses a start whose contender is not an enabled provider model", async () => {
    const { handler, store } = setup({ available: false });
    store.suiteSaved({ suite: sampleSuite() });
    const response = await handler(post(BENCHMARK_ROUTE_PATHS.runsStart, startBody));
    expect(response?.status).toBe(422);
    expect(((await response!.json()) as { message: string }).message).toContain("Contender 1");
  });

  it("refuses a start that would make more cells than a run may hold", async () => {
    const { handler, store } = setup();
    const cases = Array.from({ length: 100 }, (_, index) => ({
      caseId: `66600000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      kind: "prompt",
      title: `Case ${index}`,
      prompt: "Hi.",
      checks: [],
    }));
    store.suiteSaved({ suite: sampleSuite({ cases }) });
    const contenders = Array.from({ length: 5 }, () => ({
      providerInstanceId: benchmarkIds.providerA,
      modelId: "model-a",
    }));
    const response = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsStart, { ...startBody, contenders, repetitions: 5 }),
    );
    expect(response?.status).toBe(422);
    expect(((await response!.json()) as { message: string }).message).toContain("2500");
  });

  it("refuses a start without a budget as an invalid request", async () => {
    const { handler, store } = setup();
    store.suiteSaved({ suite: sampleSuite() });
    const response = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsStart, { ...startBody, budget: {} }),
    );
    expect(response?.status).toBe(400);
  });

  it("refuses a suite edit made from an older revision", async () => {
    const { handler, store } = setup();
    store.suiteSaved({ suite: sampleSuite({ revision: 3 }) });
    const response = await handler(
      post(BENCHMARK_ROUTE_PATHS.suitesSave, { ...saveBody, expectedRevision: 2 }),
    );
    expect(response?.status).toBe(409);
  });

  it("answers a retried start with the run it already made", async () => {
    const { handler, store, projection } = setup();
    store.suiteSaved({ suite: sampleSuite() });
    expect((await handler(post(BENCHMARK_ROUTE_PATHS.runsStart, startBody)))?.status).toBe(200);
    expect((await handler(post(BENCHMARK_ROUTE_PATHS.runsStart, startBody)))?.status).toBe(200);
    expect(projection.runs()).toHaveLength(1);
  });

  it("purges the fixed thread of a cell that never recorded one, and counts an absent thread as done", async () => {
    const { handler, store, projection, purged } = setup({ purge: "absent" });
    const run = sampleRun();
    store.runStarted({ run });
    store.cellSettled({
      runId: run.runId,
      cellId: run.cells[0]!.cellId,
      state: "failed",
      failureReason: "refused after the thread was made",
      checks: [],
      settledAt: BENCHMARK_TEST_NOW as never,
    });
    store.runEnded({ runId: run.runId, status: "cancelled", endedAt: BENCHMARK_TEST_NOW as never });

    const response = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsPurge, { runId: benchmarkIds.run }),
    );

    expect(response?.status).toBe(200);
    expect(purged).toContain(benchmarkCellIdentity(String(run.cells[0]!.cellId)).threadId);
    expect(projection.run(benchmarkIds.run)).toBeUndefined();
  });

  it("answers two identical concurrent starts with one run", async () => {
    const { handler, store, projection, kicks } = setup();
    store.suiteSaved({ suite: sampleSuite() });
    const [first, second] = await Promise.all([
      handler(post(BENCHMARK_ROUTE_PATHS.runsStart, startBody)),
      handler(post(BENCHMARK_ROUTE_PATHS.runsStart, startBody)),
    ]);
    expect([first?.status, second?.status]).toEqual([200, 200]);
    expect(projection.runs()).toHaveLength(1);
    expect(kicks).toHaveLength(1);
  });

  it("purges every cell thread of a finished run before it forgets the run, and keeps a running one", async () => {
    const { handler, store, projection, purged } = setup();
    const run = sampleRun();
    store.runStarted({ run });
    const running = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsPurge, { runId: benchmarkIds.run }),
    );
    expect(running?.status).toBe(409);

    store.cellStarted({
      runId: run.runId,
      cellId: run.cells[0]!.cellId,
      threadId: "66700000-0000-4000-8000-000000000001",
      startedAt: BENCHMARK_TEST_NOW as never,
    });
    store.runEnded({ runId: run.runId, status: "cancelled", endedAt: BENCHMARK_TEST_NOW as never });
    const response = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsPurge, { runId: benchmarkIds.run }),
    );
    expect(response?.status).toBe(200);
    expect(purged).toContain("66700000-0000-4000-8000-000000000001");
    for (const cell of run.cells) {
      expect(purged).toContain(benchmarkCellIdentity(String(cell.cellId)).threadId);
      expect(purged).toContain(benchmarkJudgeIdentity(String(cell.cellId)).threadId);
    }
    expect(projection.run(benchmarkIds.run)).toBeUndefined();
  });

  it("keeps a run when one of its threads cannot be purged", async () => {
    const { handler, store, projection } = setup({ purge: "failed" });
    const run = sampleRun();
    store.runStarted({ run });
    store.cellStarted({
      runId: run.runId,
      cellId: run.cells[0]!.cellId,
      threadId: "66700000-0000-4000-8000-000000000001",
      startedAt: BENCHMARK_TEST_NOW as never,
    });
    store.runEnded({ runId: run.runId, status: "finished", endedAt: BENCHMARK_TEST_NOW as never });
    const response = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsPurge, { runId: benchmarkIds.run }),
    );
    expect(response?.status).toBe(502);
    expect(projection.run(benchmarkIds.run)).toBeDefined();
  });

  describe("rating a cell", () => {
    function answeredRun(store: ReturnType<typeof setup>["store"]) {
      const run = sampleRun();
      store.runStarted({ run });
      store.cellSettled({
        runId: run.runId,
        cellId: run.cells[0]!.cellId,
        state: "answered",
        checks: [],
        settledAt: BENCHMARK_TEST_NOW as never,
      });
      return run;
    }
    const rateBody = (run: ReturnType<typeof sampleRun>, stars: number, note?: string) => ({
      runId: run.runId,
      cellId: run.cells[0]!.cellId,
      stars,
      ...(note === undefined ? {} : { note }),
    });

    it("lets a local window rate an answered cell and shows the stars on the run", async () => {
      const { handler, store, projection } = setup();
      const run = answeredRun(store);
      const response = await handler(
        post(BENCHMARK_ROUTE_PATHS.cellsRate, rateBody(run, 4, "Clear")),
      );
      expect(response?.status).toBe(200);
      expect(projection.run(benchmarkIds.run)!.cells[0]!.rating).toMatchObject({
        stars: 4,
        note: "Clear",
      });
      const read = await handler(post(BENCHMARK_ROUTE_PATHS.runsRead, { runId: benchmarkIds.run }));
      const detail = (await read!.json()) as { leaderboard: Array<{ meanStars?: number }> };
      expect(detail.leaderboard[0]?.meanStars).toBe(4);
    });

    it("lets a paired remote device rate a cell", async () => {
      const { handler, store, projection } = setup();
      const run = answeredRun(store);
      const response = await handler(
        post(BENCHMARK_ROUTE_PATHS.cellsRate, rateBody(run, 2), { remote: true }),
      );
      expect(response?.status).toBe(200);
      expect(projection.run(benchmarkIds.run)!.cells[0]!.rating?.stars).toBe(2);
    });

    it("replaces the earlier rating when the cell is rated again", async () => {
      const { handler, store, projection } = setup();
      const run = answeredRun(store);
      await handler(post(BENCHMARK_ROUTE_PATHS.cellsRate, rateBody(run, 5, "Great")));
      await handler(post(BENCHMARK_ROUTE_PATHS.cellsRate, rateBody(run, 1)));
      const rating = projection.run(benchmarkIds.run)!.cells[0]!.rating;
      expect(rating?.stars).toBe(1);
      expect(rating?.note).toBeUndefined();
    });

    it("refuses stars outside one to five and a fractional count", async () => {
      const { handler, store, projection } = setup();
      const run = answeredRun(store);
      for (const stars of [0, 6, 2.5]) {
        const response = await handler(post(BENCHMARK_ROUTE_PATHS.cellsRate, rateBody(run, stars)));
        expect(response?.status).toBe(400);
      }
      expect(projection.run(benchmarkIds.run)!.cells[0]!.rating).toBeUndefined();
    });

    it("refuses an anonymous request and a cell that has not been answered", async () => {
      const { handler, store } = setup();
      const run = answeredRun(store);
      const anonymous = new Request(`http://127.0.0.1:3100${BENCHMARK_ROUTE_PATHS.cellsRate}`, {
        method: "POST",
        body: JSON.stringify(rateBody(run, 3)),
      });
      expect((await handler(anonymous))?.status).toBe(401);
      const unanswered = { ...rateBody(run, 3), cellId: run.cells[1]!.cellId };
      expect((await handler(post(BENCHMARK_ROUTE_PATHS.cellsRate, unanswered)))?.status).toBe(409);
    });
  });
});
