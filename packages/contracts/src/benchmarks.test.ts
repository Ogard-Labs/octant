import { describe, expect, it } from "vitest";
import {
  MAX_BENCHMARK_CELLS,
  decodeBenchmarkRun,
  decodeBenchmarkSuite,
  decodeBenchmarkSuiteSaveRequest,
} from "./benchmarks";

const id = (suffix: number) => `63000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const at = "2026-11-07T10:00:00.000Z";

const promptCase = {
  caseId: id(10),
  kind: "prompt",
  title: "Greeting",
  prompt: "Say hello.",
  checks: [{ kind: "contains", text: "hello", caseSensitive: false }],
} as const;

const suite = {
  suiteId: id(1),
  revision: 1,
  name: "Smoke",
  cases: [promptCase],
  createdAt: at,
  updatedAt: at,
} as const;

const contender = { providerInstanceId: id(20), modelId: "model-a" } as const;

function cell(index: number, caseId: string, repetition = 1) {
  return {
    cellId: id(1_000 + index),
    caseId,
    contenderIndex: 0,
    repetition,
    state: "queued",
    checks: [],
  } as const;
}

const run = {
  runId: id(2),
  suiteId: id(1),
  suiteRevision: 1,
  suiteName: "Smoke",
  cases: [promptCase],
  contenders: [contender],
  repetitions: 1,
  budget: { maxTokens: 10_000 },
  status: "running",
  startedAt: at,
  cells: [cell(1, id(10))],
} as const;

describe("benchmark contracts", () => {
  it("decodes a valid suite and a run planned from it", () => {
    expect(decodeBenchmarkSuite(suite)).toEqual(suite);
    expect(decodeBenchmarkRun(run)).toEqual(run);
  });

  it("refuses a code-only check on a prompt case", () => {
    const refused = {
      ...suite,
      cases: [{ ...promptCase, checks: [{ kind: "max-files-changed", count: 3 }] }],
    };
    expect(() => decodeBenchmarkSuite(refused)).toThrow();
    expect(() =>
      decodeBenchmarkSuiteSaveRequest({
        suiteId: suite.suiteId,
        name: "Smoke",
        cases: refused.cases,
      }),
    ).toThrow();
  });

  it("refuses a Code case without its Code Project and a prompt case with one", () => {
    expect(() =>
      decodeBenchmarkSuite({ ...suite, cases: [{ ...promptCase, kind: "code" }] }),
    ).toThrow();
    expect(() =>
      decodeBenchmarkSuite({
        ...suite,
        cases: [{ ...promptCase, code: { codeProjectId: id(30), ref: "main" } }],
      }),
    ).toThrow();
  });

  it("refuses a run whose cells pass the bound", () => {
    const cells = Array.from({ length: MAX_BENCHMARK_CELLS + 1 }, (_, index) =>
      cell(index, id(10)),
    );
    expect(() => decodeBenchmarkRun({ ...run, cells })).toThrow();
  });

  it("refuses a run whose cells are not one per case, contender, and repetition", () => {
    expect(() => decodeBenchmarkRun({ ...run, repetitions: 2 })).toThrow();
  });

  it("refuses a run without a budget", () => {
    expect(() => decodeBenchmarkRun({ ...run, budget: {} })).toThrow();
  });
});
