import {
  MAX_PAIRED_BROWSER_FILE_BYTES,
  MAX_PAIRED_BROWSER_FRAME_BYTES,
  decodePairedBrowserResponse,
  decodePairedBrowserStreamEvent,
  type PairedBrowserChooserId,
  type PairedBrowserInput,
  type PairedBrowserLeaseId,
  type PairedBrowserRequest,
  type PairedBrowserResponse,
  type PairedBrowserStreamEvent,
} from "@octant/contracts/paired-browser-control";

const MAX_STREAM_LINE_BYTES = Math.ceil((MAX_PAIRED_BROWSER_FRAME_BYTES * 4) / 3) + 16_384;

export interface PairedBrowserTransport {
  readonly fetch: (path: string, init: RequestInit) => Promise<Response>;
}

export interface PairedBrowserControlClient {
  readonly send: (
    request: PairedBrowserRequest,
    signal?: AbortSignal,
  ) => Promise<PairedBrowserResponse>;
  readonly sendInput: (
    leaseId: PairedBrowserLeaseId,
    sequence: number,
    events: ReadonlyArray<PairedBrowserInput>,
    signal?: AbortSignal,
  ) => Promise<PairedBrowserResponse>;
  readonly release: (
    leaseId: PairedBrowserLeaseId,
    signal?: AbortSignal,
  ) => Promise<PairedBrowserResponse>;
  readonly handBack: (
    leaseId: PairedBrowserLeaseId,
    signal?: AbortSignal,
  ) => Promise<PairedBrowserResponse>;
  readonly uploadFile: (input: {
    readonly leaseId: PairedBrowserLeaseId;
    readonly chooserId: PairedBrowserChooserId;
    readonly fileName: string;
    readonly bytes: Uint8Array;
    readonly mediaType?: string;
    readonly signal?: AbortSignal;
  }) => Promise<PairedBrowserResponse>;
  readonly stream: (input: {
    readonly leaseId: PairedBrowserLeaseId;
    readonly onEvent: (event: PairedBrowserStreamEvent) => void;
    readonly signal?: AbortSignal;
  }) => Promise<
    { readonly status: "ended" } | Extract<PairedBrowserResponse, { readonly status: "refused" }>
  >;
}

export function createPairedBrowserControlClient(
  transport: PairedBrowserTransport,
): PairedBrowserControlClient {
  const send = async (
    request: PairedBrowserRequest,
    signal?: AbortSignal,
  ): Promise<PairedBrowserResponse> => {
    const response = await transport.fetch("/api/browser/remote-control/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    });
    const json: unknown = await response.json().catch(() => undefined);
    try {
      return decodePairedBrowserResponse(json);
    } catch {
      return {
        status: "refused",
        reason: response.status === 403 ? "remote-control-not-person" : "lease-ended",
      };
    }
  };

  return {
    send,
    sendInput: (leaseId, sequence, events, signal) =>
      send({ kind: "input", leaseId, sequence, events: [...events] }, signal),
    release: (leaseId, signal) => send({ kind: "release", leaseId }, signal),
    handBack: (leaseId, signal) => send({ kind: "hand-back", leaseId }, signal),
    uploadFile: async (input) => {
      if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_PAIRED_BROWSER_FILE_BYTES) {
        return { status: "refused", reason: "rate-limited" };
      }
      const response = await transport.fetch("/api/browser/remote-control/file", {
        method: "POST",
        headers: {
          "content-type": input.mediaType ?? "application/octet-stream",
          "x-octant-browser-lease-id": String(input.leaseId),
          "x-octant-browser-chooser-id": String(input.chooserId),
          "x-octant-browser-file-name": input.fileName,
        },
        body: new Uint8Array(input.bytes),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const json: unknown = await response.json().catch(() => undefined);
      try {
        return decodePairedBrowserResponse(json);
      } catch {
        return {
          status: "refused",
          reason: response.status === 403 ? "remote-control-not-person" : "lease-ended",
        };
      }
    },
    stream: async ({ leaseId, onEvent, signal }) => {
      const response = await transport.fetch("/api/browser/remote-control/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({ leaseId }),
        ...(signal === undefined ? {} : { signal }),
      });
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (!response.ok || mediaType !== "application/x-ndjson" || response.body === null) {
        const json: unknown = await response.json().catch(() => undefined);
        try {
          const decoded = decodePairedBrowserResponse(json);
          if (decoded.status === "refused") return decoded;
        } catch {
          /* Fall back to HTTP status refusal. */
        }
        return {
          status: "refused",
          reason:
            response.status === 403
              ? "remote-control-not-person"
              : response.status === 429
                ? "rate-limited"
                : "lease-ended",
        };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > MAX_STREAM_LINE_BYTES) {
            await reader.cancel();
            return { status: "refused", reason: "lease-ended" };
          }
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            onEvent(decodePairedBrowserStreamEvent(JSON.parse(trimmed)));
          }
        }
        const trailing = (buffer + decoder.decode()).trim();
        if (trailing.length > 0) {
          onEvent(decodePairedBrowserStreamEvent(JSON.parse(trailing)));
        }
        return { status: "ended" };
      } finally {
        reader.releaseLock();
      }
    },
  };
}
