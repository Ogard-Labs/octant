import {
  decodeRootlessThreadFailure,
  decodeCompatibleProjectLookupResult,
  decodeFolderAttachmentResult,
  decodeRootlessThreadCreateResult,
  decodeRootlessThreadListResult,
  decodeRootlessTurnCancelResult,
  decodeRootlessTurnLookupResult,
  type AttachFolderCommand,
  type CompatibleProjectEntry,
  type CompatibleProjectLookupRequest,
  type CreateRootlessThreadCommand,
  type FolderAttachmentResult,
  type RootlessThreadCreateResult,
  type RootlessThreadListResult,
  type RootlessThreadFailure,
  type RootlessTurnCancelResult,
  type RootlessTurnLookupResult,
  type RootlessTurnRequestId,
  type StartRootlessThreadTurnCommand,
  type CancelRootlessTurnCommand,
} from "@octant/contracts";

export interface RootlessThreadClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface RootlessThreadClient {
  createThread(command: CreateRootlessThreadCommand): Promise<RootlessThreadCreateResult>;
  startFirstTurn(command: StartRootlessThreadTurnCommand): Promise<RootlessTurnLookupResult>;
  lookupFirstTurn(requestId: RootlessTurnRequestId): Promise<RootlessTurnLookupResult>;
  cancelFirstTurn(command: CancelRootlessTurnCommand): Promise<RootlessTurnCancelResult>;
  listThreads(): Promise<RootlessThreadListResult>;
  lookupCompatibleProjects(
    request: CompatibleProjectLookupRequest,
  ): Promise<ReadonlyArray<CompatibleProjectEntry>>;
  attachFolder(command: AttachFolderCommand): Promise<FolderAttachmentResult>;
}

/** Injectable shared-renderer seam owned by the rootless first-turn backend slice. */
export type RootlessFirstTurnPort = Pick<
  RootlessThreadClient,
  "startFirstTurn" | "lookupFirstTurn" | "cancelFirstTurn"
>;

export class RootlessThreadClientFailure extends Error {
  readonly category: RootlessThreadFailure["category"];
  readonly conflictReason?: Extract<RootlessThreadFailure, { category: "conflict" }>["reason"];
  constructor(failure: RootlessThreadFailure) {
    super(failure.message);
    this.name = "RootlessThreadClientFailure";
    this.category = failure.category;
    if (failure.category === "conflict") this.conflictReason = failure.reason;
  }
}

export function createRootlessThreadClient(
  options: RootlessThreadClientOptions,
): RootlessThreadClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    createThread(command) {
      return request(
        options.fetch,
        new URL("/api/rootless/threads", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeRootlessThreadCreateResult,
      );
    },
    startFirstTurn(command) {
      return request(
        options.fetch,
        new URL("/api/rootless/turns", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeRootlessTurnLookupResult,
      );
    },
    lookupFirstTurn(requestId) {
      return request(
        options.fetch,
        new URL(`/api/rootless/turns/${encodeURIComponent(requestId)}`, options.baseUrl).toString(),
        { method: "GET", headers },
        decodeRootlessTurnLookupResult,
      );
    },
    cancelFirstTurn(command) {
      return request(
        options.fetch,
        new URL("/api/rootless/turns/cancel", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeRootlessTurnCancelResult,
      );
    },
    listThreads() {
      return request(
        options.fetch,
        new URL("/api/rootless/threads", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeRootlessThreadListResult,
      );
    },
    lookupCompatibleProjects(lookupRequest) {
      return request(
        options.fetch,
        new URL("/api/rootless/compatible-projects", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(lookupRequest),
        },
        decodeCompatibleProjectsResult,
      );
    },
    attachFolder(command) {
      return request(
        options.fetch,
        new URL("/api/rootless/attach-folder", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeFolderAttachmentResult,
      );
    },
  };
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw unavailable("Octant rootless thread service is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw unavailable("Rootless thread service returned an invalid response.");
  }
  if (!response.ok) {
    try {
      throw new RootlessThreadClientFailure(decodeRootlessThreadFailure(body));
    } catch (error) {
      if (error instanceof RootlessThreadClientFailure) throw error;
      throw unavailable("Rootless thread service returned an invalid response.");
    }
  }
  try {
    return decode(body);
  } catch {
    throw unavailable("Rootless thread service returned an invalid response.");
  }
}

function decodeCompatibleProjectsResult(value: unknown): ReadonlyArray<CompatibleProjectEntry> {
  const result = decodeCompatibleProjectLookupResult(value);
  return result.entries;
}

function unavailable(message: string): RootlessThreadClientFailure {
  return new RootlessThreadClientFailure({ category: "unavailable", message });
}
