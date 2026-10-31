import {
  DiagnosticsExportOutcome,
  JournalGrowth,
  type DiagnosticsExportRequest,
} from "@octant/contracts/diagnostics";
import {
  SupportBundleOutcome,
  SupportBundlePreview,
  type SupportBundleExportRequest,
} from "@octant/contracts/support-bundle";
import { decodeHostAnswer } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface DiagnosticsExportClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface DiagnosticsExportClient {
  exportEvidence(request: DiagnosticsExportRequest): Promise<DiagnosticsExportOutcome>;
  /** Read when diagnostics open; the host never pushes it on a timer. */
  readJournalGrowth(): Promise<JournalGrowth>;
  /** What a support bundle would hold right now. Records nothing. */
  readSupportBundlePreview(): Promise<SupportBundlePreview>;
  /** Builds the bundle's files and has the host record that they were handed over. */
  exportSupportBundle(request: SupportBundleExportRequest): Promise<SupportBundleOutcome>;
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
  async function bundleRequest(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    unavailable: string,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await resolvedFetch(new URL(path, options.baseUrl).toString(), {
        method,
        headers: buildHeaders(options.windowCapability),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      throw new DiagnosticsExportClientError(unavailable);
    } finally {
      clearTimeout(timer);
    }
    try {
      return { status: response.status, body: await response.json() };
    } catch {
      throw new DiagnosticsExportClientError(`${unavailable} It returned an invalid response.`);
    }
  }
  return {
    async readSupportBundlePreview() {
      const answer = await bundleRequest(
        "/api/diagnostics/bundle/preview",
        "GET",
        undefined,
        "The support bundle list is unavailable.",
      );
      if (answer.status !== 200) {
        throw new DiagnosticsExportClientError(
          `The support bundle list failed with status ${answer.status}.`,
        );
      }
      try {
        return decodeHostAnswer(SupportBundlePreview)(answer.body);
      } catch {
        throw new DiagnosticsExportClientError("The support bundle list was not understood.");
      }
    },
    async exportSupportBundle(request) {
      const answer = await bundleRequest(
        "/api/diagnostics/bundle",
        "POST",
        request,
        "The support bundle is unavailable.",
      );
      if (answer.status !== 200 && answer.status !== 422) {
        throw new DiagnosticsExportClientError(
          `The support bundle failed with status ${answer.status}.`,
        );
      }
      try {
        return decodeHostAnswer(SupportBundleOutcome)(answer.body);
      } catch {
        throw new DiagnosticsExportClientError("The support bundle was not understood.");
      }
    },
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
        return decodeHostAnswer(DiagnosticsExportOutcome)(body);
      } catch {
        throw new DiagnosticsExportClientError("Diagnostics export returned an invalid response.");
      }
    },
    async readJournalGrowth() {
      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
      try {
        response = await resolvedFetch(
          new URL("/api/diagnostics/journal-growth", options.baseUrl).toString(),
          {
            method: "GET",
            headers: buildHeaders(options.windowCapability),
            signal: controller.signal,
          },
        );
      } catch {
        throw new DiagnosticsExportClientError("Journal growth is unavailable.");
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new DiagnosticsExportClientError(
          `Journal growth failed with status ${response.status}.`,
        );
      }
      try {
        return decodeHostAnswer(JournalGrowth)(await response.json());
      } catch {
        throw new DiagnosticsExportClientError("Journal growth returned an invalid response.");
      }
    },
  };
}
