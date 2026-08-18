import {
  decodeScaffoldCatalogListing,
  type ScaffoldCatalogListing,
} from "@octant/contracts/scaffolds";
import { bindFetchPort } from "./bindFetchPort";

export interface ScaffoldClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class ScaffoldClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ScaffoldClientFailure";
    this.status = status;
  }
}

/**
 * Reads the curated scaffolds the host offers.
 *
 * Reading is all this client does. Running a scaffold is a Code operation and
 * goes through the Code client with every other effect on a checkout, so there
 * is one place a thread's writes are gated rather than two.
 */
export async function loadScaffoldCatalog(
  options: ScaffoldClientOptions,
  signal?: AbortSignal,
): Promise<ScaffoldCatalogListing> {
  let url: URL;
  try {
    url = new URL("/api/scaffolds", options.baseUrl);
  } catch {
    throw new ScaffoldClientFailure("Scaffold base URL is invalid.", 0);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new ScaffoldClientFailure("Scaffold base URL must be loopback.", 0);
  }
  const fetch = bindFetchPort(options.fetch);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-octant-window-capability": options.windowCapability },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new ScaffoldClientFailure("Scaffolds are unavailable.", 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ScaffoldClientFailure(
      readString(body, "error") ?? "Scaffolds are unavailable.",
      response.status,
    );
  }
  return decodeScaffoldCatalogListing(body);
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
