import {
  ArtifactLibraryClaudeSnapshotResult,
  type ArtifactLibraryClaudeCopyRequest,
  type ArtifactLibraryClaudeSnapshotRequest,
  ArtifactLibraryListing,
  type ArtifactLibraryQuery,
  type ArtifactSyncedCommand,
  ArtifactSyncedResult,
} from "@octant/contracts/artifact-library";
import { CanvasHtmlImportResult } from "@octant/contracts/canvas-cards";
import { CanvasTagCommandResult, type CanvasTagCommand } from "@octant/contracts/canvas-tags";
import { decodeHostAnswer } from "@octant/contracts";
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
  return decodeHostAnswer(ArtifactLibraryListing)(body);
}

/**
 * Sends one synced-artifact command to the host: read where its versions came
 * from, open it in a thread, keep one of two versions, merge them, or restore
 * it. The host decides each one; a refusal comes back as a result, not an error.
 */
export async function executeSyncedArtifactCommand(
  options: ArtifactLibraryClientOptions,
  command: ArtifactSyncedCommand,
): Promise<ArtifactSyncedResult> {
  let url: URL;
  try {
    url = new URL("/api/artifacts/synced", options.baseUrl);
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
      body: JSON.stringify(command),
    });
  } catch {
    throw new ArtifactLibraryClientFailure("Synced artifacts are unavailable.", 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ArtifactLibraryClientFailure(
      readString(body, "error") ?? "Synced artifacts are unavailable.",
      response.status,
    );
  }
  return decodeHostAnswer(ArtifactSyncedResult)(body);
}

/**
 * Sends one tag change to the host: add or remove a tag on a Canvas. The host
 * decides it; a refusal comes back as a result, not an error, so the library
 * can say why without looking like the request failed to arrive.
 */
export async function changeArtifactTag(
  options: ArtifactLibraryClientOptions,
  command: CanvasTagCommand,
): Promise<CanvasTagCommandResult> {
  let url: URL;
  try {
    url = new URL("/api/artifacts/tag", options.baseUrl);
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
      body: JSON.stringify(command),
    });
  } catch {
    throw new ArtifactLibraryClientFailure("Artifact tags are unavailable.", 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ArtifactLibraryClientFailure(
      readString(body, "error") ?? "Artifact tags are unavailable.",
      response.status,
    );
  }
  return decodeHostAnswer(CanvasTagCommandResult)(body);
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Reads the copy Octant kept of a Claude page's published file, through the
 * publishing thread's own read check. `unavailable` for a page published from
 * a type with no local file, a thread this window cannot read, or a paired
 * device, which opens the page on claude.ai instead.
 */
export async function loadClaudePageSnapshot(
  options: ArtifactLibraryClientOptions,
  request: ArtifactLibraryClaudeSnapshotRequest,
): Promise<ArtifactLibraryClaudeSnapshotResult> {
  return decodeHostAnswer(ArtifactLibraryClaudeSnapshotResult)(
    await postClaudePageRequest(
      options,
      "/api/artifacts/claude-snapshot",
      request,
      "The page's snapshot is unavailable.",
    ),
  );
}

/**
 * Copies a Claude page's kept HTML snapshot into a new Canvas in the Project
 * of the thread that published it. The host reads the snapshot itself and
 * runs it through the HTML importer; a paired device is refused.
 */
export async function copyClaudePageToCanvas(
  options: ArtifactLibraryClientOptions,
  request: ArtifactLibraryClaudeCopyRequest,
): Promise<CanvasHtmlImportResult> {
  return decodeHostAnswer(CanvasHtmlImportResult)(
    await postClaudePageRequest(
      options,
      "/api/artifacts/claude-copy",
      request,
      "The page could not be copied into a Canvas.",
    ),
  );
}

async function postClaudePageRequest(
  options: ArtifactLibraryClientOptions,
  path: string,
  request: unknown,
  unavailable: string,
): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(path, options.baseUrl);
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
      body: JSON.stringify(request),
    });
  } catch {
    throw new ArtifactLibraryClientFailure(unavailable, 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ArtifactLibraryClientFailure(
      readString(body, "error") ?? unavailable,
      response.status,
    );
  }
  return body;
}
