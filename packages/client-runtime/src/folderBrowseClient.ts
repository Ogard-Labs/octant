import {
  decodeFolderBrowseResult,
  decodeFolderSelectionResult,
  decodeFolderBrowseFailure,
  type FolderBrowseFailure,
  type FolderBrowseRequest,
  type FolderBrowseResult,
  type FolderSelectionRequest,
  type FolderSelectionResult,
} from "@octant/contracts/folder-browse";
import { bindFetchPort } from "./bindFetchPort";

export interface FolderBrowseClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface FolderBrowseClient {
  browse(request: FolderBrowseRequest): Promise<FolderBrowseResult>;
  select(request: FolderSelectionRequest): Promise<FolderSelectionResult>;
}

export class FolderBrowseClientFailure extends Error {
  readonly category: FolderBrowseFailure["category"];
  constructor(failure: FolderBrowseFailure) {
    super(failure.message);
    this.name = "FolderBrowseClientFailure";
    this.category = failure.category;
  }
}

export function createFolderBrowseClient(options: FolderBrowseClientOptions): FolderBrowseClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    browse(request) {
      return post(
        fetch,
        new URL("/api/folders/browse", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        decodeFolderBrowseResult,
      );
    },
    select(request) {
      return post(
        fetch,
        new URL("/api/folders/select", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        decodeFolderSelectionResult,
      );
    },
  };
}

async function post<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new FolderBrowseClientFailure({
      category: "unavailable",
      message: "Folder browse service is unavailable.",
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FolderBrowseClientFailure({
      category: "unavailable",
      message: "Folder browse returned an invalid response.",
    });
  }
  if (!response.ok) {
    try {
      throw new FolderBrowseClientFailure(decodeFolderBrowseFailure(body));
    } catch (error) {
      if (error instanceof FolderBrowseClientFailure) throw error;
      throw new FolderBrowseClientFailure({
        category: "unavailable",
        message: "Folder browse returned an invalid response.",
      });
    }
  }
  try {
    return decode(body);
  } catch {
    throw new FolderBrowseClientFailure({
      category: "unavailable",
      message: "Folder browse returned an invalid response.",
    });
  }
}
