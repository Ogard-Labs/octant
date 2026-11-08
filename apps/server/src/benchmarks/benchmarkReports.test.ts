import {
  BENCHMARK_ROUTE_PATHS,
  decodeBenchmarkRun,
  type BenchmarkRun,
  type TurnMetricsRecord,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { BenchmarkReports, csvField } from "./benchmarkReports";
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
const SECRET_ANSWER = "The sentinel answer text that must never be exported";
const thread = (n: number) => `66300000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function metricsRecord(threadId: string): TurnMetricsRecord {
  return {
    threadId,
    mode: "chat",
    providerInstanceId: benchmarkIds.providerA,
    modelId: "model-a",
    stopReason: "end-of-turn",
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
    metrics: { wallMs: 900, timeToFirstTokenMs: 120 },
    diagnostics: { toolCalls: 3, toolFailures: 1 },
    startedAt: BENCHMARK_TEST_NOW,
    endedAt: BENCHMARK_TEST_NOW,
  } as unknown as TurnMetricsRecord;
}

function setup() {
  const opened = openBenchmarkTestStore();
  const suite = sampleSuite({
    cases: [
      {
        caseId: benchmarkIds.caseA,
        kind: "prompt",
        title: '=HYPERLINK("x"), "quoted"',
        prompt: "Say hello.",
        checks: [{ kind: "contains", text: "hello", caseSensitive: false }],
      },
    ],
  });
  opened.store.suiteSaved({ suite });
  const service = new BenchmarkService({
    projection: opened.projection,
    store: opened.store,
    turnMetrics: { forThread: (threadId) => [metricsRecord(threadId)] },
    runner: { cancel: async (runId) => opened.projection.run(runId), kick: () => undefined },
    contenderAvailable: () => true,
    ensureProject: async () => ({ status: "ready" }),
    purgeThread: async () => "purged",
    clock: () => BENCHMARK_TEST_NOW,
    uuid: opened.uuid,
  });
  const reports = new BenchmarkReports({
    projection: opened.projection,
    turnMetrics: { forThread: (threadId) => [metricsRecord(threadId)] },
    readRun: (request) => service.readRun(request),
    providerLabel: () => "Provider, A",
  });
  const startRun = (runId: string, startedAt: string, passed: boolean, n: number): BenchmarkRun => {
    const base = sampleRun({ suite });
    const run = decodeBenchmarkRun({ ...base, runId, startedAt });
    opened.store.runStarted({ run });
    const cell = run.cells[0]!;
    opened.store.cellStarted({
      runId: run.runId,
      cellId: cell.cellId,
      threadId: thread(n),
      startedAt,
    } as never);
    opened.store.cellSettled({
      runId: run.runId,
      cellId: cell.cellId,
      state: "answered",
      checks: [{ index: 0, passed }],
      settledAt: startedAt,
    } as never);
    opened.store.cellJudged({
      runId: run.runId,
      cellId: cell.cellId,
      judge: { status: "scored", score: 7, reason: "Fine.", judgeThreadId: thread(90 + n) },
    } as never);
    opened.store.cellRated({
      runId: run.runId,
      cellId: cell.cellId,
      rating: { stars: 4, ratedAt: startedAt },
    } as never);
    return run;
  };
  return { ...opened, service, reports, startRun, suite };
}

const OLD = "66400000-0000-4000-8000-000000000001";
const NEW = "66400000-0000-4000-8000-000000000002";

describe("benchmark history", () => {
  it("lists a suite's runs newest first with a figures row per contender", () => {
    const { reports, startRun, suite } = setup();
    startRun(OLD, "2026-11-01T10:00:00.000Z", false, 1);
    startRun(NEW, "2026-11-05T10:00:00.000Z", true, 2);

    const history = reports.history({ suiteId: suite.suiteId });

    expect(history.runs.map((run) => run.runId)).toEqual([NEW, OLD]);
    expect(history.runs[0]?.rows[0]).toMatchObject({
      contender: { modelId: "model-a" },
      checkPassRate: 1,
      meanJudgeScore: 7,
      meanStars: 4,
      firstTokenP50Ms: 120,
      totalTokens: 150,
      failedCount: 0,
    });
    expect(history.runs[1]?.rows[0]?.checkPassRate).toBe(0);
  });

  it("is empty for a suite with no runs", () => {
    const { reports } = setup();
    expect(reports.history({ suiteId: benchmarkIds.suite as never }).runs).toEqual([]);
  });
});

describe("benchmark export", () => {
  it("writes the run, cells, figures, leaderboard, and overhead as JSON without answer text", () => {
    const { reports, startRun } = setup();
    const run = startRun(NEW, "2026-11-05T10:00:00.000Z", true, 2);

    const result = reports.exportRun({ runId: run.runId, format: "json" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.contentType).toBe("application/json");
    expect(result.value.fileName).toBe("benchmark-smoke-66400000.json");
    expect(result.value.content).not.toContain(SECRET_ANSWER);
    const body = JSON.parse(result.value.content) as Record<string, any>;
    expect(body.answers).toBe(
      "Answers are not included; read them in each cell's thread. Judge reasons, check details and star notes are included and may quote an answer.",
    );
    expect(Object.keys(body.cells[0]).filter((key) => /answer|text|reply/i.test(key))).toEqual([]);
    expect(body.cells[0]).toMatchObject({
      state: "answered",
      checks: [{ index: 0, passed: true }],
      judge: { status: "scored", score: 7 },
      rating: { stars: 4 },
      metrics: { timeToFirstTokenMs: 120, wallMs: 900, costUsd: 0.02, toolFailures: 1 },
    });
    expect(body.run.budget).toEqual({ maxTokens: 1_000_000 });
    expect(body.run.contenders[0].label).toBe("Provider, A model-a");
    expect(body.leaderboard).toHaveLength(1);
  });

  it("writes one CSV row per cell, quoted, with formulas neutralised", () => {
    const { reports, startRun } = setup();
    const run = startRun(NEW, "2026-11-05T10:00:00.000Z", true, 2);

    const result = reports.exportRun({ runId: run.runId, format: "csv" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const lines = result.value.content.split("\r\n");
    expect(lines[0]).toBe(
      "Case,Contender,Repetition,State,Checks passed,Judge score,Stars,First token ms,Duration ms,Input tokens,Output tokens,Cost USD,Tool failures",
    );
    expect(lines[1]).toBe(
      `"'=HYPERLINK(""x""), ""quoted""","Provider, A model-a",1,answered,1/1,7,4,120,900,100,50,0.02,1`,
    );
    expect(lines).toHaveLength(3);
    expect(result.value.contentType).toContain("text/csv");
  });

  it("refuses a run that does not exist", () => {
    const { reports } = setup();
    expect(reports.exportRun({ runId: NEW as never, format: "csv" })).toMatchObject({
      status: "refused",
      reason: "not-found",
    });
  });
});

describe("csv fields", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])(
    "prefixes %j with an apostrophe",
    (value) => {
      expect(csvField(value).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    },
  );
  it("leaves plain text alone and quotes commas, quotes, and newlines", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField(undefined)).toBe("");
    expect(csvField(0)).toBe("0");
  });
});

describe("benchmark history and export routes", () => {
  function handlerFor(context: ReturnType<typeof setup>) {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now: Date.now() });
    return createBenchmarkRouteHandler({
      windowAuthorityStore,
      service: context.service,
      reports: context.reports,
      now: () => Date.now(),
    });
  }
  function post(path: string, body: unknown, remote: boolean): Request {
    const request = new Request(`http://127.0.0.1:3100${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-octant-window-capability": capability },
      body: JSON.stringify(body),
    });
    if (remote) {
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

  it("lets a remote device read history and export a run, and still refuses a remote start", async () => {
    const context = setup();
    context.startRun(NEW, "2026-11-05T10:00:00.000Z", true, 2);
    const handler = handlerFor(context);

    const history = await handler(
      post(BENCHMARK_ROUTE_PATHS.suitesHistory, { suiteId: benchmarkIds.suite }, true),
    );
    expect(history?.status).toBe(200);
    expect(((await history!.json()) as { runs: unknown[] }).runs).toHaveLength(1);

    const exported = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsExport, { runId: NEW, format: "csv" }, true),
    );
    expect(exported?.status).toBe(200);
    expect(((await exported!.json()) as { fileName: string }).fileName).toMatch(/\.csv$/);

    const started = await handler(
      post(
        BENCHMARK_ROUTE_PATHS.runsStart,
        {
          runId: "66400000-0000-4000-8000-000000000003",
          suiteId: benchmarkIds.suite,
          contenders: [{ providerInstanceId: benchmarkIds.providerA, modelId: "model-a" }],
          repetitions: 1,
          budget: { maxTokens: 10 },
        },
        true,
      ),
    );
    expect(started?.status).toBe(403);
  });

  it("answers an unknown run with 404 and a bad export format with 400", async () => {
    const handler = handlerFor(setup());
    const missing = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsExport, { runId: NEW, format: "json" }, false),
    );
    expect(missing?.status).toBe(404);
    const bad = await handler(
      post(BENCHMARK_ROUTE_PATHS.runsExport, { runId: NEW, format: "xml" }, false),
    );
    expect(bad?.status).toBe(400);
  });
});
