import {
  decodeUsagePurgeResult,
  decodeUsageQueryResponse,
  type UsageExportFormat,
  type UsageExportRequest,
  type UsagePurgeResult,
  type UsageQueryFilter,
  type UsageQueryRequest,
  type UsageQueryResponse,
  type UsageResetRequest,
  type UsageRetentionRequest,
} from "@octant/contracts/usage-rpc";
import { bindFetchPort } from "./bindFetchPort";

export interface UsageClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface UsageExportResult {
  readonly format: UsageExportFormat;
  readonly body: string;
}

export interface UsageClient {
  query(request: UsageQueryRequest): Promise<UsageQueryResponse>;
  export(request: UsageExportRequest): Promise<UsageExportResult>;
  reset(request: UsageResetRequest): Promise<UsagePurgeResult>;
  retain(request: UsageRetentionRequest): Promise<UsagePurgeResult>;
}

export class UsageClientError extends Error {
  override readonly name = "UsageClientError";
  constructor(message: string) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const EXPORT_TIMEOUT_MS = 30_000;

function buildHeaders(windowCapability: string): Record<string, string> {
  return {
    "x-octant-window-capability": windowCapability,
    "content-type": "application/json",
  };
}

async function postJson(
  options: UsageClientOptions,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await options.fetch(new URL(path, options.baseUrl).toString(), {
      method: "POST",
      headers: buildHeaders(options.windowCapability),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new UsageClientError("Usage service is unavailable.");
  } finally {
    clearTimeout(timer);
  }
  return response;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new UsageClientError("Usage service returned an invalid response.");
  }
}

export function createUsageClient(options: UsageClientOptions): UsageClient {
  const resolved: UsageClientOptions = {
    ...options,
    fetch: bindFetchPort(options.fetch),
  };
  return {
    async query(request) {
      const response = await postJson(resolved, "/api/usage/query", request, DEFAULT_TIMEOUT_MS);
      if (!response.ok) {
        throw new UsageClientError(`Usage query failed with status ${response.status}.`);
      }
      const body = await readJsonBody(response);
      try {
        return decodeUsageQueryResponse(body);
      } catch {
        throw new UsageClientError("Usage service returned an invalid response.");
      }
    },
    async export(request) {
      const response = await postJson(resolved, "/api/usage/export", request, EXPORT_TIMEOUT_MS);
      if (!response.ok) {
        throw new UsageClientError(`Usage export failed with status ${response.status}.`);
      }
      const body = await response.text();
      return { format: request.format, body };
    },
    async reset(request) {
      const response = await postJson(resolved, "/api/usage/reset", request, DEFAULT_TIMEOUT_MS);
      if (!response.ok) {
        throw new UsageClientError(`Usage reset failed with status ${response.status}.`);
      }
      const body = await readJsonBody(response);
      try {
        return decodeUsagePurgeResult(body);
      } catch {
        throw new UsageClientError("Usage service returned an invalid response.");
      }
    },
    async retain(request) {
      const response = await postJson(resolved, "/api/usage/retain", request, DEFAULT_TIMEOUT_MS);
      if (!response.ok) {
        throw new UsageClientError(`Usage retention failed with status ${response.status}.`);
      }
      const body = await readJsonBody(response);
      try {
        return decodeUsagePurgeResult(body);
      } catch {
        throw new UsageClientError("Usage service returned an invalid response.");
      }
    },
  };
}

export type { UsageQueryFilter };
