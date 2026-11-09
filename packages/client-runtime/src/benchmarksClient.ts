import {
  BENCHMARK_ROUTE_PATHS,
  BenchmarkCellRateResponse,
  BenchmarkHistoryResponse,
  BenchmarkRunExportResponse,
  BenchmarkRunCancelResponse,
  BenchmarkRunPurgeResponse,
  BenchmarkRunReadResponse,
  BenchmarkRunsListResponse,
  BenchmarkRunStartResponse,
  BenchmarkSuiteDeleteResponse,
  BenchmarkSuiteSaveResponse,
  BenchmarkSuitesListResponse,
  decodeHostAnswer,
  type BenchmarkCellRateRequest,
  type BenchmarkHistoryRequest,
  type BenchmarkRunExportRequest,
  type BenchmarkRunCancelRequest,
  type BenchmarkRunPurgeRequest,
  type BenchmarkRunReadRequest,
  type BenchmarkRunsListRequest,
  type BenchmarkRunStartRequest,
  type BenchmarkSuiteDeleteRequest,
  type BenchmarkSuiteSaveRequest,
} from "@octant/contracts";
import { Schema } from "effect";
import { bindFetchPort } from "./bindFetchPort";

export interface BenchmarksClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface BenchmarksClient {
  listSuites(): Promise<BenchmarkSuitesListResponse>;
  saveSuite(request: BenchmarkSuiteSaveRequest): Promise<BenchmarkSuiteSaveResponse>;
  deleteSuite(request: BenchmarkSuiteDeleteRequest): Promise<BenchmarkSuiteDeleteResponse>;
  listRuns(request: BenchmarkRunsListRequest): Promise<BenchmarkRunsListResponse>;
  /** A run with its leaderboard and each cell's measured figures. */
  readRun(request: BenchmarkRunReadRequest): Promise<BenchmarkRunReadResponse>;
  startRun(request: BenchmarkRunStartRequest): Promise<BenchmarkRunStartResponse>;
  cancelRun(request: BenchmarkRunCancelRequest): Promise<BenchmarkRunCancelResponse>;
  purgeRun(request: BenchmarkRunPurgeRequest): Promise<BenchmarkRunPurgeResponse>;
  /** Stars for one answered cell; rating again replaces the earlier rating. */
  rateCell(request: BenchmarkCellRateRequest): Promise<BenchmarkCellRateResponse>;
  /** A suite's runs, newest first, each with one row of figures per contender. */
  history(request: BenchmarkHistoryRequest): Promise<BenchmarkHistoryResponse>;
  /** A run as a JSON or CSV file to save; it never carries answer text. */
  exportRun(request: BenchmarkRunExportRequest): Promise<BenchmarkRunExportResponse>;
}

/** A refusal keeps the host's own sentence and status, so a page can show why. */
export class BenchmarksClientError extends Error {
  override readonly name = "BenchmarksClientError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const SAVE_TIMEOUT_MS = 30_000;

export function createBenchmarksClient(options: BenchmarksClientOptions): BenchmarksClient {
  const fetch = bindFetchPort(options.fetch);

  async function call<A, I>(
    path: string,
    body: unknown,
    schema: Schema.Schema<A, I, never>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<A> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(new URL(path, options.baseUrl).toString(), {
        method: "POST",
        headers: {
          "x-octant-window-capability": options.windowCapability,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new BenchmarksClientError("Benchmarks are unavailable.");
    } finally {
      clearTimeout(timer);
    }
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      throw new BenchmarksClientError("Benchmarks returned an invalid response.", response.status);
    }
    if (!response.ok) {
      const message =
        typeof answer === "object" && answer !== null && "message" in answer
          ? String(answer.message)
          : `Benchmarks failed with status ${response.status}.`;
      throw new BenchmarksClientError(message, response.status);
    }
    try {
      return decodeHostAnswer(schema)(answer);
    } catch {
      throw new BenchmarksClientError("Benchmarks returned an invalid response.", response.status);
    }
  }

  return {
    listSuites: () => call(BENCHMARK_ROUTE_PATHS.suitesList, {}, BenchmarkSuitesListResponse),
    saveSuite: (request) =>
      call("/api/benchmarks/suites/save", request, BenchmarkSuiteSaveResponse, SAVE_TIMEOUT_MS),
    deleteSuite: (request) =>
      call("/api/benchmarks/suites/delete", request, BenchmarkSuiteDeleteResponse),
    listRuns: (request) => call(BENCHMARK_ROUTE_PATHS.runsList, request, BenchmarkRunsListResponse),
    readRun: (request) => call(BENCHMARK_ROUTE_PATHS.runsRead, request, BenchmarkRunReadResponse),
    startRun: (request) =>
      call("/api/benchmarks/runs/start", request, BenchmarkRunStartResponse, SAVE_TIMEOUT_MS),
    cancelRun: (request) =>
      call("/api/benchmarks/runs/cancel", request, BenchmarkRunCancelResponse),
    purgeRun: (request) => call("/api/benchmarks/runs/purge", request, BenchmarkRunPurgeResponse),
    rateCell: (request) => call("/api/benchmarks/cells/rate", request, BenchmarkCellRateResponse),
    history: (request) => call("/api/benchmarks/suites/history", request, BenchmarkHistoryResponse),
    exportRun: (request) =>
      call("/api/benchmarks/runs/export", request, BenchmarkRunExportResponse, SAVE_TIMEOUT_MS),
  };
}
