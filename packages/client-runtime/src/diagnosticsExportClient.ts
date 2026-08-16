import {
  decodeDiagnosticsExportOutcome,
  type DiagnosticsExportOutcome,
  type DiagnosticsExportRequest,
} from "@octant/contracts/diagnostics";
import { bindFetchPort } from "./bindFetchPort";

export interface DiagnosticsExportClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface DiagnosticsExportClient {
  exportEvidence(request: DiagnosticsExportRequest): Promise<DiagnosticsExportOutcome>;
}

export class DiagnosticsExportClientError extends Error {
  override readonly name = "DiagnosticsExportClientError";
  constructor(message: string) {
    super(message);
  }
}

const EXPORT_TIMEOUT_MS = 30_000;

function buildHeaders(windowCapability: string): Record<string, string> {
  return {
    "x-octant-window-capability": windowCapability,
    "content-type": "application/json",
  };
}

export function createDiagnosticsExportClient(
  options: DiagnosticsExportClientOptions,
): DiagnosticsExportClient {
  const resolvedFetch = bindFetchPort(options.fetch);
  return {
    async exportEvidence(request) {
      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
      try {
        response = await resolvedFetch(
          new URL("/api/diagnostics/export", options.baseUrl).toString(),
          {
            method: "POST",
            headers: buildHeaders(options.windowCapability),
            body: JSON.stringify(request),
            signal: controller.signal,
          },
        );
      } catch {
        throw new DiagnosticsExportClientError("Diagnostics export service is unavailable.");
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok && response.status !== 422) {
        throw new DiagnosticsExportClientError(
          `Diagnostics export failed with status ${response.status}.`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new DiagnosticsExportClientError("Diagnostics export returned an invalid response.");
      }

      try {
        return decodeDiagnosticsExportOutcome(body);
      } catch {
        throw new DiagnosticsExportClientError("Diagnostics export returned an invalid response.");
      }
    },
  };
}
