import {
  decodeNativeHarnessFollowUpActivationResult,
  decodeNativeHarnessFollowUpPreview,
  decodeNativeHarnessProjectRoutingOverride,
  decodeNativeHarnessRoutingCommandResult,
  decodeNativeHarnessRoutingSettings,
  decodeNativeHarnessSessionCommandResult,
  decodeNativeHarnessSessionView,
  type ActivateNativeHarnessFollowUp,
  type NativeHarnessFollowUpActivationResult,
  type NativeHarnessFollowUpPreview,
  type NativeHarnessProjectRoutingOverride,
  type NativeHarnessRoutingCommandResult,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessRoutingSettings,
  type NativeHarnessSessionCommand,
  type NativeHarnessSessionCommandResult,
  type NativeHarnessSessionView,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface NativeHarnessClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface NativeHarnessClient {
  routing(signal?: AbortSignal): Promise<NativeHarnessRoutingSettings>;
  updateRouting(
    input: {
      readonly configuration: NativeHarnessRoutingConfiguration;
      readonly expectedVersion: number;
    },
    signal?: AbortSignal,
  ): Promise<NativeHarnessRoutingCommandResult>;
  projectRouting(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<NativeHarnessProjectRoutingOverride | null>;
  setProjectRouting(
    projectId: string,
    input: {
      readonly configuration: NativeHarnessRoutingConfiguration;
      readonly expectedVersion: number;
    },
    signal?: AbortSignal,
  ): Promise<NativeHarnessRoutingCommandResult>;
  clearProjectRouting(
    projectId: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<NativeHarnessRoutingCommandResult>;
  session(threadId: string, signal?: AbortSignal): Promise<NativeHarnessSessionView | null>;
  command(
    threadId: string,
    command: NativeHarnessSessionCommand,
    signal?: AbortSignal,
  ): Promise<NativeHarnessSessionCommandResult>;
  previewFollowUp(
    threadId: string,
    suggestionId: string,
    signal?: AbortSignal,
  ): Promise<NativeHarnessFollowUpPreview | NativeHarnessFollowUpActivationResult>;
  activateFollowUp(
    threadId: string,
    activation: ActivateNativeHarnessFollowUp,
    signal?: AbortSignal,
  ): Promise<NativeHarnessFollowUpActivationResult>;
}

export class NativeHarnessClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "NativeHarnessClientFailure";
    this.status = status;
  }
}

/**
 * Client for the native harness surfaces: slot routing and the per-thread
 * session view. The host decides everything; this carries the window
 * capability and decodes what came back, so every surface — web, desktop,
 * phone, CLI — renders the same shapes.
 */
export function createNativeHarnessClient(
  options: NativeHarnessClientOptions,
): NativeHarnessClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = { "x-octant-window-capability": options.windowCapability };
  const url = (path: string) => new URL(path, options.baseUrl).toString();
  const get = (path: string, signal?: AbortSignal) =>
    send(fetch, url(path), { method: "GET", headers, ...(signal === undefined ? {} : { signal }) });
  const write = (
    method: "PUT" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) =>
    send(fetch, url(path), {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });

  return {
    async routing(signal) {
      const body = await get("/api/native-harness/routing", signal);
      return decodeNativeHarnessRoutingSettings((body as { settings: unknown }).settings);
    },
    async updateRouting(input, signal) {
      return decodeNativeHarnessRoutingCommandResult(
        await write("PUT", "/api/native-harness/routing", input, signal),
      );
    },
    async projectRouting(projectId, signal) {
      const body = await get(
        `/api/native-harness/routing/projects/${encodeURIComponent(projectId)}`,
        signal,
      );
      const override = (body as { override: unknown }).override;
      return override === null || override === undefined
        ? null
        : decodeNativeHarnessProjectRoutingOverride(override);
    },
    async setProjectRouting(projectId, input, signal) {
      return decodeNativeHarnessRoutingCommandResult(
        await write(
          "PUT",
          `/api/native-harness/routing/projects/${encodeURIComponent(projectId)}`,
          input,
          signal,
        ),
      );
    },
    async clearProjectRouting(projectId, expectedVersion, signal) {
      return decodeNativeHarnessRoutingCommandResult(
        await write(
          "DELETE",
          `/api/native-harness/routing/projects/${encodeURIComponent(projectId)}?expectedVersion=${expectedVersion}`,
          undefined,
          signal,
        ),
      );
    },
    async session(threadId, signal) {
      const body = await get(
        `/api/native-harness/sessions/${encodeURIComponent(threadId)}`,
        signal,
      );
      const view = (body as { view: unknown }).view;
      return view === null || view === undefined ? null : decodeNativeHarnessSessionView(view);
    },
    async command(threadId, command, signal) {
      return decodeNativeHarnessSessionCommandResult(
        await write(
          "POST",
          `/api/native-harness/sessions/${encodeURIComponent(threadId)}/commands`,
          command,
          signal,
        ),
      );
    },
    async previewFollowUp(threadId, suggestionId, signal) {
      const body = await write(
        "POST",
        `/api/native-harness/sessions/${encodeURIComponent(threadId)}/follow-ups/preview`,
        { suggestionId },
        signal,
      );
      const preview = (body as { preview?: unknown }).preview;
      return preview === undefined
        ? decodeNativeHarnessFollowUpActivationResult(body)
        : decodeNativeHarnessFollowUpPreview(preview);
    },
    async activateFollowUp(threadId, activation, signal) {
      return decodeNativeHarnessFollowUpActivationResult(
        await write(
          "POST",
          `/api/native-harness/sessions/${encodeURIComponent(threadId)}/follow-ups/activate`,
          activation,
          signal,
        ),
      );
    },
  };
}

async function send(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new NativeHarnessClientFailure("The native harness service is unavailable.", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new NativeHarnessClientFailure(
      "The native harness response is malformed.",
      response.status,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new NativeHarnessClientFailure(
      "The native harness request is unauthorized.",
      response.status,
    );
  }
  // A refused command is a value the caller reads, not a transport failure.
  if (!response.ok && !isRefusal(body)) {
    const message =
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : "The native harness request failed.";
    throw new NativeHarnessClientFailure(message, response.status);
  }
  return body;
}

function isRefusal(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const kind = (body as { kind?: unknown }).kind;
  return (
    kind === "routing-refused" ||
    kind === "native-harness-session-refused" ||
    kind === "follow-up-refused"
  );
}
