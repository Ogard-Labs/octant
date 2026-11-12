import type { EventActor } from "@octant/contracts";
import { principalActsAsHostPerson } from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import {
  BENCHMARK_ROUTE_PATHS,
  decodeBenchmarkCellRateRequest,
  decodeBenchmarkHistoryRequest,
  decodeBenchmarkRunExportRequest,
  decodeBenchmarkRunCancelRequest,
  decodeBenchmarkRunPurgeRequest,
  decodeBenchmarkRunReadRequest,
  decodeBenchmarkRunsListRequest,
  decodeBenchmarkRunStartRequest,
  decodeBenchmarkSuiteDeleteRequest,
  decodeBenchmarkSuiteSaveRequest,
  decodeBenchmarkSuitesListRequest,
  type WindowId,
} from "@octant/contracts";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { BenchmarkReports } from "./benchmarkReports";
import type { BenchmarkOutcome, BenchmarkService } from "./benchmarkService";

const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
/** A suite of 100 cases of 20,000 characters is about 2 MB before escaping. */
const MAX_BODY_BYTES = 8 * 1_048_576;

const READ_PATHS: ReadonlySet<string> = new Set([
  BENCHMARK_ROUTE_PATHS.suitesList,
  BENCHMARK_ROUTE_PATHS.runsList,
  BENCHMARK_ROUTE_PATHS.runsRead,
  BENCHMARK_ROUTE_PATHS.suitesHistory,
  BENCHMARK_ROUTE_PATHS.runsExport,
  // Stars are a small non-secret write any principal that may read may make.
  BENCHMARK_ROUTE_PATHS.cellsRate,
]);
const WRITE_PATHS: ReadonlySet<string> = new Set([
  BENCHMARK_ROUTE_PATHS.suitesSave,
  BENCHMARK_ROUTE_PATHS.suitesDelete,
  BENCHMARK_ROUTE_PATHS.runsStart,
  BENCHMARK_ROUTE_PATHS.runsCancel,
  BENCHMARK_ROUTE_PATHS.runsPurge,
]);

export interface BenchmarkRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly allowedRendererHttpOrigin?: string | null;
  readonly service: Pick<
    BenchmarkService,
    | "listSuites"
    | "saveSuite"
    | "deleteSuite"
    | "listRuns"
    | "readRun"
    | "startRun"
    | "cancelRun"
    | "purgeRun"
    | "rateCell"
  >;
  /** History and export reads; a host without them answers those two paths as unavailable. */
  readonly reports?: Pick<BenchmarkReports, "history" | "exportRun">;
  readonly now?: () => number;
}

/**
 * Benchmark routes. A local window and an authorized remote device may read
 * suites and runs and rate a cell with stars (a note on one answer, spending
 * nothing). Saving or deleting a suite, and starting, cancelling, or
 * purging a run, spend money or erase threads, so they stay with a person at a
 * local window: any other principal is refused before the body is read.
 */
export function createBenchmarkRouteHandler(
  dependencies: BenchmarkRouteDependencies,
): (request: Request) => Promise<Response | undefined> {
  const now = dependencies.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (!READ_PATHS.has(url.pathname) && !WRITE_PATHS.has(url.pathname)) return undefined;
    const origin = request.headers.get("origin");
    const allowedOrigin = dependencies.allowedRendererHttpOrigin;
    if (!isLoopbackHostname(url.hostname))
      return failure("Benchmarks require loopback.", 400, null);
    if (origin !== null && !isAllowedRendererOrigin(origin, allowedOrigin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigin) });
    }
    if (request.method !== "POST" || url.search !== "") {
      return failure("Benchmarks require POST.", 405, origin, allowedOrigin);
    }
    let windowId: WindowId;
    let actor: EventActor;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      windowId = context.scopeId;
      actor = eventActorForPrincipal(context.principal);
      if (WRITE_PATHS.has(url.pathname) && !principalActsAsHostPerson(context.principal)) {
        return failure("Benchmark changes stay with a local window.", 403, origin, allowedOrigin);
      }
    } catch (error) {
      return failure(
        "Benchmark request is unauthorized.",
        error instanceof WindowAuthorityError ? 401 : 400,
        origin,
        allowedOrigin,
      );
    }
    let body: unknown;
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) {
        return failure("Benchmark request is too large.", 413, origin, allowedOrigin);
      }
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return failure("Benchmark request is invalid.", 400, origin, allowedOrigin);
    }
    try {
      return await dispatch(
        url.pathname,
        body,
        windowId,
        actor,
        dependencies.service,
        dependencies.reports,
        origin,
        allowedOrigin,
      );
    } catch {
      return failure("Benchmarks are unavailable.", 503, origin, allowedOrigin);
    }
  };
}

async function dispatch(
  path: string,
  body: unknown,
  windowId: WindowId,
  actor: EventActor,
  service: BenchmarkRouteDependencies["service"],
  reports: BenchmarkRouteDependencies["reports"],
  origin: string | null,
  allowedOrigin: string | null | undefined,
): Promise<Response> {
  const answer = <T>(outcome: BenchmarkOutcome<T>, shape: (value: T) => unknown): Response =>
    outcome.status === "ok"
      ? json(shape(outcome.value), origin, allowedOrigin)
      : failure(outcome.message, REFUSAL_STATUS[outcome.reason], origin, allowedOrigin);
  const parse = <T>(decode: (input: unknown) => T): T | undefined => {
    try {
      return decode(body);
    } catch {
      return undefined;
    }
  };
  const invalid = () => failure("Benchmark request is invalid.", 400, origin, allowedOrigin);
  switch (path) {
    case BENCHMARK_ROUTE_PATHS.suitesList: {
      return parse(decodeBenchmarkSuitesListRequest) === undefined
        ? invalid()
        : json({ suites: service.listSuites() }, origin, allowedOrigin);
    }
    case BENCHMARK_ROUTE_PATHS.suitesSave: {
      const request = parse(decodeBenchmarkSuiteSaveRequest);
      return request === undefined
        ? invalid()
        : answer(service.saveSuite(request, actor), (suite) => ({ suite }));
    }
    case BENCHMARK_ROUTE_PATHS.suitesDelete: {
      const request = parse(decodeBenchmarkSuiteDeleteRequest);
      return request === undefined
        ? invalid()
        : answer(service.deleteSuite(request, actor), (value) => value);
    }
    case BENCHMARK_ROUTE_PATHS.runsList: {
      const request = parse(decodeBenchmarkRunsListRequest);
      return request === undefined
        ? invalid()
        : json(service.listRuns(request), origin, allowedOrigin);
    }
    case BENCHMARK_ROUTE_PATHS.runsRead: {
      const request = parse(decodeBenchmarkRunReadRequest);
      return request === undefined ? invalid() : answer(service.readRun(request), (value) => value);
    }
    case BENCHMARK_ROUTE_PATHS.suitesHistory: {
      if (reports === undefined)
        return failure("Benchmarks are unavailable.", 503, origin, allowedOrigin);
      const request = parse(decodeBenchmarkHistoryRequest);
      return request === undefined
        ? invalid()
        : json(reports.history(request), origin, allowedOrigin);
    }
    case BENCHMARK_ROUTE_PATHS.runsExport: {
      if (reports === undefined)
        return failure("Benchmarks are unavailable.", 503, origin, allowedOrigin);
      const request = parse(decodeBenchmarkRunExportRequest);
      return request === undefined
        ? invalid()
        : answer(reports.exportRun(request), (value) => value);
    }
    case BENCHMARK_ROUTE_PATHS.runsStart: {
      const request = parse(decodeBenchmarkRunStartRequest);
      return request === undefined
        ? invalid()
        : answer(await service.startRun(windowId, request, actor), (run) => ({ run }));
    }
    case BENCHMARK_ROUTE_PATHS.runsCancel: {
      const request = parse(decodeBenchmarkRunCancelRequest);
      return request === undefined
        ? invalid()
        : answer(await service.cancelRun(request, actor), (run) => ({ run }));
    }
    case BENCHMARK_ROUTE_PATHS.cellsRate: {
      const request = parse(decodeBenchmarkCellRateRequest);
      return request === undefined
        ? invalid()
        : answer(service.rateCell(request, actor), (value) => value);
    }
    default: {
      const request = parse(decodeBenchmarkRunPurgeRequest);
      return request === undefined
        ? invalid()
        : answer(await service.purgeRun(request, actor), (value) => value);
    }
  }
}

const REFUSAL_STATUS = {
  "not-found": 404,
  conflict: 409,
  invalid: 422,
  unavailable: 502,
} as const;

function json(
  value: unknown,
  origin: string | null,
  allowedOrigin: string | null | undefined,
): Response {
  return Response.json(value, { status: 200, headers: corsHeaders(origin, allowedOrigin) });
}

function failure(
  message: string,
  status: number,
  origin: string | null,
  allowedOrigin?: string | null,
): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin, allowedOrigin) });
}

function corsHeaders(origin: string | null, allowedOrigin?: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin, allowedOrigin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}
