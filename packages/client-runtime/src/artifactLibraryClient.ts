import {
  decodeArtifactLibraryListing,
  type ArtifactLibraryListing,
  type ArtifactLibraryQuery,
} from "@octant/contracts/artifact-library";
import { bindFetchPort } from "./bindFetchPort";

export interface ArtifactLibraryClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class ArtifactLibraryClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ArtifactLibraryClientFailure";
    this.status = status;
  }
}

/**
 * Reads the host's artifact library.
 *
 * The query goes to the host and the host applies it. A renderer that filtered
 * a wider list locally would be filtering something it was already given, which
 * is a weaker guarantee than being given only what it may see.
 */
export async function loadArtifactLibrary(
  options: ArtifactLibraryClientOptions,
  query: ArtifactLibraryQuery,
  signal?: AbortSignal,
): Promise<ArtifactLibraryListing> {
  let url: URL;
  try {
    url = new URL("/api/artifacts/library", options.baseUrl);
  } catch {
    throw new ArtifactLibraryClientFailure("Artifact library base URL is invalid.", 0);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new ArtifactLibraryClientFailure("Artifact library base URL must be loopback.", 0);
  }
  const fetch = bindFetchPort(options.fetch);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(query),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new ArtifactLibraryClientFailure("The artifact library is unavailable.", 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ArtifactLibraryClientFailure(
      readString(body, "error") ?? "The artifact library is unavailable.",
      response.status,
    );
  }
  return decodeArtifactLibraryListing(body);
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
