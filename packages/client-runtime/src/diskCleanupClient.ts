import { decodeHostAnswer } from "@octant/contracts";
import {
  HostWorktreeScan,
  RemoveHostWorktreeResult,
  RemoveXcodeBuildDataResult,
  XcodeBuildDataList,
  type RemoveHostWorktreeRequest,
} from "@octant/contracts/disk-cleanup";
import { bindFetchPort } from "./bindFetchPort";

export interface DiskCleanupClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class DiskCleanupClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DiskCleanupClientFailure";
    this.status = status;
  }
}

/** Settings › Code: the worktrees and Xcode build data on this computer that Octant did not make. */
export interface DiskCleanupClient {
  worktrees(signal?: AbortSignal): Promise<HostWorktreeScan>;
  scanWorktrees(signal?: AbortSignal): Promise<HostWorktreeScan>;
  removeWorktree(
    request: RemoveHostWorktreeRequest,
    signal?: AbortSignal,
  ): Promise<RemoveHostWorktreeResult>;
  xcodeBuildData(signal?: AbortSignal): Promise<XcodeBuildDataList>;
  removeXcodeBuildData(
    names: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<RemoveXcodeBuildDataResult>;
}

export function createDiskCleanupClient(options: DiskCleanupClientOptions): DiskCleanupClient {
  const fetch = bindFetchPort(options.fetch);
  const call = (
    path: string,
    method: "GET" | "POST",
    body: unknown,
    fallback: string,
    signal?: AbortSignal,
  ) =>
    send(
      fetch,
      new URL(path, options.baseUrl).toString(),
      {
        method,
        headers: {
          "x-octant-window-capability": options.windowCapability,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      },
      fallback,
    );
  return {
    async worktrees(signal) {
      const body = await call(
        "/api/code/host-worktrees",
        "GET",
        undefined,
        "Worktrees could not be read from this host.",
        signal,
      );
      return decodeHostAnswer(HostWorktreeScan)(body);
    },
    async scanWorktrees(signal) {
      const body = await call(
        "/api/code/host-worktrees/scan",
        "POST",
        undefined,
        "This computer could not be scanned for worktrees.",
        signal,
      );
      return decodeHostAnswer(HostWorktreeScan)(body);
    },
    async removeWorktree(request, signal) {
      const body = await call(
        "/api/code/host-worktrees/remove",
        "POST",
        request,
        "The worktree could not be removed.",
        signal,
      );
      return decodeHostAnswer(RemoveHostWorktreeResult)(body);
    },
    async xcodeBuildData(signal) {
      const body = await call(
        "/api/apple/xcode-build-data",
        "GET",
        undefined,
        "Xcode build data could not be read from this host.",
        signal,
      );
      return decodeHostAnswer(XcodeBuildDataList)(body);
    },
    async removeXcodeBuildData(names, signal) {
      const body = await call(
        "/api/apple/xcode-build-data/remove",
        "POST",
        { names, confirmed: true },
        "Xcode build data could not be removed.",
        signal,
      );
      return decodeHostAnswer(RemoveXcodeBuildDataResult)(body);
    },
  };
}

/** A refusal is an answer, whatever the status: it says why nothing was removed. */
function isRefusal(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "kind" in body &&
    body.kind === "host-worktree-refused"
  );
}

async function send(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  fallback: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new DiskCleanupClientFailure(fallback, 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DiskCleanupClientFailure(fallback, response.status);
  }
  if (!response.ok && !isRefusal(body)) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    throw new DiskCleanupClientFailure(message, response.status);
  }
  return body;
}
