import { decodeHostAnswer } from "@octant/contracts";
import {
  RepositoryBootstrapFailure,
  RepositoryBootstrapInspectResult,
  RepositoryBootstrapLandFilesResult,
  RepositoryBootstrapOperationResponse,
  RepositoryBootstrapReadFileResult,
  type RepositoryBootstrapCancelCloneRequest,
  type RepositoryBootstrapCloneStatusRequest,
  type RepositoryBootstrapFailureCode,
  type RepositoryBootstrapInspectRequest,
  type RepositoryBootstrapLandFilesRequest,
  type RepositoryBootstrapReadFileRequest,
  type RepositoryBootstrapStartCloneRequest,
} from "@octant/contracts/repository-bootstrap";
import { bindFetchPort } from "./bindFetchPort";

export interface RepositoryBootstrapClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
  readonly requestTimeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 25_000;

export class RepositoryBootstrapClientFailure extends Error {
  readonly code: RepositoryBootstrapFailureCode;

  constructor(failure: RepositoryBootstrapFailure) {
    super(failure.message);
    this.name = "RepositoryBootstrapClientFailure";
    this.code = failure.code;
  }
}

export interface RepositoryBootstrapClient {
  inspect(
    request: RepositoryBootstrapInspectRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryBootstrapInspectResult>;
  readIgnoredFile(
    request: RepositoryBootstrapReadFileRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryBootstrapReadFileResult>;
  startClone(
    request: RepositoryBootstrapStartCloneRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryBootstrapOperationResponse>;
  cloneStatus(
    request: RepositoryBootstrapCloneStatusRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryBootstrapOperationResponse>;
  cancelClone(
    request: RepositoryBootstrapCancelCloneRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryBootstrapOperationResponse>;
  landFiles(
    request: RepositoryBootstrapLandFilesRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryBootstrapLandFilesResult>;
}

export function createRepositoryBootstrapClient(
  options: RepositoryBootstrapClientOptions,
): RepositoryBootstrapClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = {
    "x-octant-window-capability": options.windowCapability,
    "content-type": "application/json",
  };
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const call = <T>(
    path: string,
    payload: unknown,
    decode: (value: unknown) => T,
    signal?: AbortSignal,
  ) =>
    postJson(
      fetch,
      new URL(path, options.baseUrl).toString(),
      headers,
      payload,
      decode,
      timeoutMs,
      signal,
    );

  return {
    inspect: (request, signal) =>
      call(
        "/api/projects/repository-bootstrap/inspect",
        request,
        decodeHostAnswer(RepositoryBootstrapInspectResult),
        signal,
      ),
    readIgnoredFile: (request, signal) =>
      call(
        "/api/projects/repository-bootstrap/read-ignored-file",
        request,
        decodeHostAnswer(RepositoryBootstrapReadFileResult),
        signal,
      ),
    startClone: (request, signal) =>
      call(
        "/api/projects/repository-bootstrap/clone",
        request,
        decodeHostAnswer(RepositoryBootstrapOperationResponse),
        signal,
      ),
    cloneStatus: (request, signal) =>
      call(
        "/api/projects/repository-bootstrap/clone/status",
        request,
        decodeHostAnswer(RepositoryBootstrapOperationResponse),
        signal,
      ),
    cancelClone: (request, signal) =>
      call(
        "/api/projects/repository-bootstrap/clone/cancel",
        request,
        decodeHostAnswer(RepositoryBootstrapOperationResponse),
        signal,
      ),
    landFiles: (request, signal) =>
      call(
        "/api/projects/repository-bootstrap/land-files",
        request,
        decodeHostAnswer(RepositoryBootstrapLandFilesResult),
        signal,
      ),
  };
}

async function postJson<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  payload: unknown,
  decode: (value: unknown) => T,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      if (callerSignal?.aborted === true) {
        throw new RepositoryBootstrapClientFailure({
          code: "cancelled",
          message: "Repository bootstrap request was cancelled.",
        });
      }
      throw new RepositoryBootstrapClientFailure({
        code: "unavailable",
        message: "Repository bootstrap service is unavailable.",
      });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RepositoryBootstrapClientFailure({
        code: "unavailable",
        message: "Repository bootstrap returned an invalid response.",
      });
    }
    if (!response.ok) {
      try {
        throw new RepositoryBootstrapClientFailure(
          decodeHostAnswer(RepositoryBootstrapFailure)(body),
        );
      } catch (error) {
        if (error instanceof RepositoryBootstrapClientFailure) throw error;
        throw new RepositoryBootstrapClientFailure({
          code: "unavailable",
          message: "Repository bootstrap returned an invalid response.",
        });
      }
    }
    try {
      return decode(body);
    } catch {
      throw new RepositoryBootstrapClientFailure({
        code: "unavailable",
        message: "Repository bootstrap returned an invalid response.",
      });
    }
  } finally {
    clearTimeout(timer);
    if (callerSignal !== undefined) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}
