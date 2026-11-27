import type {
  PinnedListenerExchangeOpening,
  PinnedListenerExchangePort,
  PinnedListenerExchangeRead,
  PinnedTlsStreamEvent,
  PinnedTlsStreamPort,
} from "@octant/client-runtime";

/** The in-tree native module that holds a listener connection to its pin. */
export interface OctantPinnedTlsNativeModule {
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly open: (
    id: string,
    address: string,
    port: number,
    serverName: string | null,
    pins: ReadonlyArray<string>,
    requestBase64: string,
  ) => Promise<unknown>;
  readonly read: (id: string) => Promise<unknown>;
  readonly cancel: (id: string) => void;
  /**
   * The same pinned TLS over bytes the app carries through the hub's relay.
   * Absent in a build made before the module had it, which then never relays.
   */
  readonly streamOpen?: (
    id: string,
    serverName: string | null,
    pins: ReadonlyArray<string>,
    requestBase64: string,
  ) => void;
  readonly streamPush?: (id: string, chunkBase64: string) => void;
  readonly streamPushEnd?: (id: string) => void;
  readonly streamPull?: (id: string) => Promise<unknown>;
  readonly streamCancel?: (id: string) => void;
}

/**
 * The client runtime's stream port over the native module, or undefined when
 * the module has no stream. An event the module should never give reads as
 * a failure, so a damaged answer is never read as an opening or as bytes.
 */
export function nativePinnedTlsStreamPort(
  native: OctantPinnedTlsNativeModule,
): PinnedTlsStreamPort | undefined {
  const { streamOpen, streamPush, streamPushEnd, streamPull, streamCancel } = native;
  if (
    streamOpen === undefined ||
    streamPush === undefined ||
    streamPushEnd === undefined ||
    streamPull === undefined ||
    streamCancel === undefined
  ) {
    return undefined;
  }
  return {
    open: (id, input) => streamOpen(id, null, input.pins, toBase64(input.request)),
    push: (id, chunk) => streamPush(id, toBase64(chunk)),
    pushEnd: (id) => streamPushEnd(id),
    pull: async (id) => readStreamEvent(await streamPull(id)),
    cancel: (id) => streamCancel(id),
  };
}

function readStreamEvent(answer: unknown): PinnedTlsStreamEvent {
  const failed = { status: "failed", reason: "connection-failed" } as const;
  if (typeof answer !== "object" || answer === null) return failed;
  const record = answer as Record<string, unknown>;
  if ((record.status === "send" || record.status === "data") && typeof record.chunk === "string") {
    return { status: record.status, chunk: fromBase64(record.chunk) };
  }
  if (record.status === "opened" && typeof record.servedPin === "string") {
    return { status: "opened", servedPin: record.servedPin };
  }
  if (record.status === "refused") {
    return typeof record.servedPin === "string"
      ? { status: "refused", servedPin: record.servedPin }
      : { status: "refused" };
  }
  if (record.status === "failed" && typeof record.reason === "string") {
    return { status: "failed", reason: record.reason };
  }
  if (record.status === "end") return { status: "end" };
  return failed;
}

let nextExchange = 0;

/**
 * The client runtime's exchange port over the native module. Bytes cross as
 * base64; an answer the module should never give reads as a failure, so a
 * damaged answer is never read as an opening, a refusal, or reply bytes.
 */
export function nativePinnedTlsExchangePort(
  native: OctantPinnedTlsNativeModule,
): PinnedListenerExchangePort {
  return {
    resolve: (hostname) => native.resolve(hostname),
    open: async (request) => {
      nextExchange += 1;
      const id = `exchange-${nextExchange}`;
      if (request.signal?.aborted === true) {
        return { status: "failed", reason: "connection-failed" };
      }
      // An abort while the handshake runs cancels it before the request is written.
      const cancel = () => native.cancel(id);
      request.signal?.addEventListener("abort", cancel, { once: true });
      let answer: unknown;
      try {
        answer = await native.open(
          id,
          request.address,
          request.port,
          request.serverName ?? null,
          request.pins,
          toBase64(request.request),
        );
      } finally {
        request.signal?.removeEventListener("abort", cancel);
      }
      const opening = readOpening(answer);
      if (opening.status !== "opened") return opening;
      return {
        status: "opened",
        servedPin: opening.servedPin,
        read: async () => readNext(await native.read(id)),
        close: () => native.cancel(id),
      };
    },
  };
}

type Opening =
  | { readonly status: "opened"; readonly servedPin: string }
  | Exclude<PinnedListenerExchangeOpening, { readonly status: "opened" }>;

function readOpening(answer: unknown): Opening {
  const failed = { status: "failed", reason: "connection-failed" } as const;
  if (typeof answer !== "object" || answer === null) return failed;
  const record = answer as Record<string, unknown>;
  const servedPin = typeof record.servedPin === "string" ? record.servedPin : undefined;
  if (record.status === "opened" && servedPin !== undefined) return { status: "opened", servedPin };
  if (record.status === "refused") return { status: "refused", servedPin };
  if (
    record.status === "failed" &&
    (record.reason === "unreachable" ||
      record.reason === "handshake-failed" ||
      record.reason === "connection-failed")
  ) {
    return { status: "failed", reason: record.reason };
  }
  return failed;
}

function readNext(answer: unknown): PinnedListenerExchangeRead {
  if (typeof answer !== "object" || answer === null) return { status: "failed" };
  const record = answer as Record<string, unknown>;
  if (record.status === "data" && typeof record.chunk === "string") {
    return { status: "data", chunk: fromBase64(record.chunk) };
  }
  if (record.status === "end") return { status: "end" };
  return { status: "failed" };
}
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.byteLength; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
