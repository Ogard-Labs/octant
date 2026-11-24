import {
  THREAD_VIDEO_ARCHIVE_QUERY,
  ThreadExportOutcome,
  ThreadVideoArchiveOffer,
  type THREAD_EXPORT_PATH,
  type ThreadExportRequest,
} from "@octant/contracts/thread-export";
import {
  decodeHostAnswer,
  ThreadToolCallRecordsResult,
  type ThreadToolCallRecordsRequest,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ThreadExportClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ThreadExportClient {
  exportThread(request: ThreadExportRequest): Promise<ThreadExportOutcome>;
  /** An older host ignores archive negotiation and answers with its usual JSON bundle. */
  offerArchive?(request: ThreadExportRequest): Promise<ThreadVideoArchiveOffer>;
  /** One turn's kept tool-call records. A refusal is an answer, not a thrown error. */
  readToolCallRecords(request: ThreadToolCallRecordsRequest): Promise<ThreadToolCallRecordsResult>;
}

export class ThreadExportClientError extends Error {
  override readonly name = "ThreadExportClientError";
  constructor(message: string) {
    super(message);
  }
}

const EXPORT_TIMEOUT_MS = 30_000;
const EXPORT_PATH: typeof THREAD_EXPORT_PATH = "/api/threads/export";

export function createThreadExportClient(options: ThreadExportClientOptions): ThreadExportClient {
  const resolvedFetch = bindFetchPort(options.fetch);
  /** Both commands answer a refusal as a 401 or 404 body the caller decodes. */
  const post = async (path: string, label: string, request: unknown): Promise<unknown> => {
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
    try {
      response = await resolvedFetch(new URL(path, options.baseUrl).toString(), {
        method: "POST",
        headers: {
          "x-octant-window-capability": options.windowCapability,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch {
      throw new ThreadExportClientError(`${label} is unavailable.`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok && response.status !== 404 && response.status !== 401) {
      throw new ThreadExportClientError(`${label} failed with status ${response.status}.`);
    }

    try {
      return await response.json();
    } catch {
      throw new ThreadExportClientError(`${label} returned an invalid response.`);
    }
  };
  return {
    async exportThread(request) {
      const body = await post(EXPORT_PATH, "Thread export", request);
      try {
        return decodeHostAnswer(ThreadExportOutcome)(body);
      } catch {
        throw new ThreadExportClientError("Thread export returned an invalid response.");
      }
    },
    async offerArchive(request) {
      const body = await post(
        `${EXPORT_PATH}?${THREAD_VIDEO_ARCHIVE_QUERY}=1`,
        "Thread export",
        request,
      );
      try {
        const offer = decodeHostAnswer(ThreadVideoArchiveOffer)(body);
        return offer.kind === "archive-ready"
          ? { ...offer, url: new URL(offer.url, options.baseUrl).toString() }
          : offer;
      } catch {
        throw new ThreadExportClientError("Thread video archive returned an invalid response.");
      }
    },
    async readToolCallRecords(request) {
      const body = await post("/api/threads/tool-call-records", "Tool-call records", request);
      try {
        return decodeHostAnswer(ThreadToolCallRecordsResult)(body);
      } catch {
        throw new ThreadExportClientError("Tool-call records returned an invalid response.");
      }
    },
  };
}
