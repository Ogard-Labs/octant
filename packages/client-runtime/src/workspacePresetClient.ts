import {
  decodeWorkspacePresetApplied,
  decodeWorkspacePresetCatalogListing,
  type WorkspacePresetApplied,
  type WorkspacePresetApplyRequest,
  type WorkspacePresetCatalogListing,
} from "@octant/contracts/workspace-presets";
import { bindFetchPort } from "./bindFetchPort";

export interface WorkspacePresetClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class WorkspacePresetClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkspacePresetClientFailure";
    this.status = status;
  }
}

/** Reads the curated workspace presets the host offers. */
export async function loadWorkspacePresetCatalog(
  options: WorkspacePresetClientOptions,
  signal?: AbortSignal,
): Promise<WorkspacePresetCatalogListing> {
  return decodeWorkspacePresetCatalogListing(
    await send(options, "/api/workspace-presets", { method: "GET" }, signal),
  );
}

/**
 * Applies one preset to a Code thread this window already has open.
 *
 * The request carries a preset's id and nothing about the layout: the host
 * composes every operation from the pinned preset, so this client selects a
 * preset and never authors one. The skills it reports back are a reading, not
 * a change — applying a preset enables nothing.
 */
export async function applyWorkspacePreset(
  options: WorkspacePresetClientOptions,
  request: WorkspacePresetApplyRequest,
  signal?: AbortSignal,
): Promise<WorkspacePresetApplied> {
  return decodeWorkspacePresetApplied(
    await send(
      options,
      "/api/workspace-presets/apply",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      signal,
    ),
  );
}

async function send(
  options: WorkspacePresetClientOptions,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(path, options.baseUrl);
  } catch {
    throw new WorkspacePresetClientFailure("Workspace preset base URL is invalid.", 0);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new WorkspacePresetClientFailure("Workspace preset base URL must be loopback.", 0);
  }
  const fetch = bindFetchPort(options.fetch);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        "x-octant-window-capability": options.windowCapability,
      },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new WorkspacePresetClientFailure("Workspace presets are unavailable.", 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new WorkspacePresetClientFailure(
      readString(body, "error") ?? "Workspace presets are unavailable.",
      response.status,
    );
  }
  return body;
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
