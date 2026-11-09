import {
  decodeBenchmarkRun,
  decodeBenchmarkRunReadResponse,
  decodeBenchmarkRunsListResponse,
  decodeBenchmarkSuite,
  type BenchmarkRun,
  type BenchmarkRunReadResponse,
  type BenchmarkRunSummary,
  type BenchmarkSuite,
} from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";

export const NOW = "2026-11-07T12:00:00.000Z";
export const PROVIDER = "77000000-0000-4000-8000-000000000001";
export const SUITE_ID = "77000000-0000-4000-8000-0000000000a1";
export const CASE_ONE = "77000000-0000-4000-8000-0000000000b1";
export const CASE_TWO = "77000000-0000-4000-8000-0000000000b2";
export const RUN_ID = "77000000-0000-4000-8000-0000000000c1";
export const THREAD_FAST = "77000000-0000-4000-8000-0000000000d1";
export const THREAD_DEEP = "77000000-0000-4000-8000-0000000000d2";
export const TURN_FAST = "77000000-0000-4000-8000-0000000000e1";
export const TURN_DEEP = "77000000-0000-4000-8000-0000000000e2";
const CELL = (n: number) => `77000000-0000-4000-8000-00000000f${String(n).padStart(3, "0")}`;

export function suite(overrides: Partial<Record<string, unknown>> = {}): BenchmarkSuite {
  return decodeBenchmarkSuite({
    suiteId: SUITE_ID,
    revision: 2,
    name: "Capital cities",
    description: "Short factual questions.",
    cases: [
      {
        caseId: CASE_ONE,
        kind: "prompt",
        title: "Capital of Norway",
        prompt: "What is the capital of Norway?",
        checks: [{ kind: "contains", text: "Oslo", caseSensitive: false }],
      },
      {
        caseId: CASE_TWO,
        kind: "prompt",
        title: "Capital of Sweden",
        prompt: "What is the capital of Sweden?",
        checks: [],
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

const contenders = [
  { providerInstanceId: PROVIDER, modelId: "model-fast" },
  { providerInstanceId: PROVIDER, modelId: "model-deep" },
];

export function run(status: BenchmarkRun["status"] = "running"): BenchmarkRun {
  const ended = status !== "running";
  return decodeBenchmarkRun({
    runId: RUN_ID,
    suiteId: SUITE_ID,
    suiteRevision: 2,
    suiteName: "Capital cities",
    cases: suite().cases,
    contenders,
    repetitions: 1,
    budget: { maxCostUsd: 1 },
    status,
    startedAt: NOW,
    ...(ended ? { endedAt: NOW, endReason: "Every cell settled." } : {}),
    cells: [
      {
        cellId: CELL(1),
        caseId: CASE_ONE,
        contenderIndex: 0,
        repetition: 1,
        state: "answered",
        threadId: THREAD_FAST,
        turnId: TURN_FAST,
        startedAt: NOW,
        settledAt: NOW,
        checks: [{ index: 0, passed: true }],
        judge: {
          status: "scored",
          score: 9,
          reason: "Correct and brief.",
          judgeThreadId: THREAD_FAST,
        },
      },
      {
        cellId: CELL(2),
        caseId: CASE_ONE,
        contenderIndex: 1,
        repetition: 1,
        state: "answered",
        threadId: THREAD_DEEP,
        turnId: TURN_DEEP,
        startedAt: NOW,
        settledAt: NOW,
        checks: [{ index: 0, passed: false, detail: "Oslo was not in the answer." }],
      },
      {
        cellId: CELL(3),
        caseId: CASE_TWO,
        contenderIndex: 0,
        repetition: 1,
        state: ended ? "answered" : "running",
        ...(ended ? { threadId: THREAD_FAST, turnId: TURN_FAST } : {}),
        checks: [],
      },
      {
        cellId: CELL(4),
        caseId: CASE_TWO,
        contenderIndex: 1,
        repetition: 1,
        state: ended ? "failed" : "queued",
        ...(ended ? { failureReason: "The turn finished without an answer." } : {}),
        checks: [],
      },
    ],
  });
}

export function readResponse(status: BenchmarkRun["status"] = "running"): BenchmarkRunReadResponse {
  return decodeBenchmarkRunReadResponse({
    run: run(status),
    leaderboard: [
      {
        contenderIndex: 0,
        cells: 2,
        answered: 1,
        checkPassRate: 1,
        meanJudgeScore: 9,
        firstTokenP50Ms: 400,
        firstTokenP95Ms: 600,
        tokensPerSecondP50: 80,
        tokensPerSecondP95: 95,
        totalTokens: 1_200,
        totalCostUsd: 0.02,
        toolFailureRate: 0,
        failedCount: 0,
        blockedCount: 0,
      },
      {
        contenderIndex: 1,
        cells: 2,
        answered: 1,
        checkPassRate: 0,
        firstTokenP50Ms: 900,
        firstTokenP95Ms: 1_500,
        tokensPerSecondP50: 40,
        totalTokens: 3_000,
        failedCount: 1,
        blockedCount: 0,
      },
    ],
    cellMetrics: [
      {
        cellId: CELL(1),
        metrics: {
          stopReason: "end-of-turn",
          wallMs: 2_000,
          timeToFirstTokenMs: 400,
          totalTokens: 600,
          costUsd: 0.01,
        },
      },
      {
        cellId: CELL(2),
        metrics: { stopReason: "end-of-turn", wallMs: 5_000, totalTokens: 1_500 },
      },
    ],
  });
}

export function summary(status: BenchmarkRunSummary["status"] = "running"): BenchmarkRunSummary {
  const [first] = decodeBenchmarkRunsListResponse({
    runs: [
      {
        runId: RUN_ID,
        suiteId: SUITE_ID,
        suiteName: "Capital cities",
        suiteRevision: 2,
        status,
        startedAt: NOW,
        contenderCount: 2,
        repetitions: 1,
        cellCount: 4,
        settledCount: status === "running" ? 2 : 4,
        answeredCount: 2,
        failedCount: status === "running" ? 0 : 1,
      },
    ],
  }).runs;
  if (first === undefined) throw new Error("fixture run summary missing");
  return first;
}

/** Two ready models on one account, enough for the picker and the names. */
export function providerSnapshot(): ProviderRegistrySnapshot {
  const capability = "supported" as const;
  const model = (id: string, displayName: string) => ({
    id: id as never,
    displayName,
    reasoning: "supported" as const,
    inputModalities: ["text"] as const,
    options: [],
    source: "discovered" as const,
    verification: "verified" as const,
  });
  return {
    defaults: { permissionPersistence: "current-session", version: 1 as never },
    instances: [
      {
        id: PROVIDER as never,
        displayName: "Provider A",
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1 as never,
        createdAt: NOW as never,
        updatedAt: NOW as never,
        driverKind: "opencode",
        configuration: { kind: "opencode-cli", binaryPath: "/usr/local/bin/opencode" },
      },
    ],
    observedStates: [
      {
        instanceId: PROVIDER as never,
        readiness: "ready" as const,
        processState: "running" as const,
        models: [model("model-fast", "Fast model"), model("model-deep", "Deep model")],
        capabilities: {
          streaming: capability,
          resume: capability,
          interruption: capability,
          approvals: capability,
          userQuestions: capability,
          reasoning: capability,
          usage: capability,
          toolActivity: capability,
          fileChanges: "unsupported" as const,
          diffs: "unsupported" as const,
          taskProgress: capability,
          nativeChildAgents: "unsupported" as const,
          harnessAutoReview: "unsupported" as const,
          nativeAttachments: capability,
          nativeWebResearch: capability,
          appManagedTools: capability,
          citations: capability,
        },
        observedAt: NOW as never,
      },
    ],
  };
}
