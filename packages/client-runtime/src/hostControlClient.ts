import {
  decodeHostBackupOutcome,
  decodeHostControlStatus,
  decodeHostLifecycleOutcome,
  decodeHostRestoreOutcome,
  type HostBackupOutcome,
  type HostControlStatus,
  type HostLifecycleAction,
  type HostLifecycleOutcome,
  type HostRestoreOutcome,
} from "@octant/contracts/host-control";
import {
  decodePurgeThreadsOutcome,
  decodeSetThreadRetentionOutcome,
  decodeThreadRetentionState,
  type PurgeThreadsOutcome,
  type PurgeThreadsRequest,
  type SetThreadRetentionOutcome,
  type SetThreadRetentionRequest,
  type ThreadRetentionState,
} from "@octant/contracts/thread-retention";
import { bindFetchPort } from "./bindFetchPort";

/**
 * Local-principal client for the authenticated `/api/host-control` surface.
 * Every call carries the window capability; the server refuses
 * anything else, so this client is only useful to an authorized local window.
 */

export interface HostControlClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface HostControlClient {
  status(): Promise<HostControlStatus>;
  lifecycle(action: HostLifecycleAction): Promise<HostLifecycleOutcome>;
  backup(label?: string): Promise<HostBackupOutcome>;
  restore(): Promise<HostRestoreOutcome>;
  readThreadRetention(): Promise<ThreadRetentionState>;
  setThreadRetention(request: SetThreadRetentionRequest): Promise<SetThreadRetentionOutcome>;
  purgeThreads(request: PurgeThreadsRequest): Promise<PurgeThreadsOutcome>;
}

export class HostControlClientError extends Error {
  override readonly name = "HostControlClientError";
  constructor(message: string) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

export function createHostControlClient(options: HostControlClientOptions): HostControlClient {
  const resolvedFetch = bindFetchPort(options.fetch);

  async function call(input: {
    readonly path: string;
    readonly method: "GET" | "POST";
    readonly body?: unknown;
    /** Statuses whose bodies still carry a decodable outcome (e.g. failed backup). */
    readonly decodableStatuses?: readonly number[];
  }): Promise<unknown> {
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      response = await resolvedFetch(new URL(input.path, options.baseUrl).toString(), {
        method: input.method,
        headers: {
          "x-octant-window-capability": options.windowCapability,
          ...(input.method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(input.method === "POST" ? { body: JSON.stringify(input.body ?? {}) } : {}),
        signal: controller.signal,
      });
    } catch {
      throw new HostControlClientError("The host control service is unreachable.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok && !(input.decodableStatuses ?? []).includes(response.status)) {
      throw new HostControlClientError(
        `Host control request failed with status ${response.status}.`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new HostControlClientError("Host control returned an invalid response.");
    }
  }

  function decodeOrThrow<A>(decode: (value: unknown) => A, value: unknown): A {
    try {
      return decode(value);
    } catch {
      throw new HostControlClientError("Host control returned an invalid response.");
    }
  }

  return {
    async status() {
      const body = await call({ path: "/api/host-control/status", method: "GET" });
      return decodeOrThrow(decodeHostControlStatus, body);
    },
    async lifecycle(action) {
      const body = await call({
        path: "/api/host-control/lifecycle",
        method: "POST",
        body: { action },
      });
      return decodeOrThrow(decodeHostLifecycleOutcome, body);
    },
    async backup(label) {
      const body = await call({
        path: "/api/host-control/backup",
        method: "POST",
        body: label === undefined ? {} : { label },
        decodableStatuses: [503],
      });
      return decodeOrThrow(decodeHostBackupOutcome, body);
    },
    async restore() {
      const body = await call({ path: "/api/host-control/restore", method: "POST", body: {} });
      return decodeOrThrow(decodeHostRestoreOutcome, body);
    },
    async readThreadRetention() {
      const body = await call({ path: "/api/host-control/thread-retention", method: "GET" });
      return decodeOrThrow(decodeThreadRetentionState, body);
    },
    async setThreadRetention(request) {
      const body = await call({
        path: "/api/host-control/thread-retention",
        method: "POST",
        body: request,
        decodableStatuses: [403],
      });
      return decodeOrThrow(decodeSetThreadRetentionOutcome, body);
    },
    async purgeThreads(request) {
      const body = await call({
        path: "/api/host-control/thread-purge",
        method: "POST",
        body: request,
        decodableStatuses: [403],
      });
      return decodeOrThrow(decodePurgeThreadsOutcome, body);
    },
  };
}
