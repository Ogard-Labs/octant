import type {
  PinnedListenerExchangeOutcome,
  PinnedListenerExchangePort,
} from "@octant/client-runtime";

/** The in-tree native module that holds a listener connection to its pin. */
export interface OctantPinnedTlsNativeModule {
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly exchange: (
    id: string,
    address: string,
    port: number,
    serverName: string | null,
    pins: ReadonlyArray<string>,
    requestBase64: string,
  ) => Promise<unknown>;
  readonly cancel: (id: string) => void;
}

let nextExchange = 0;

/**
 * The client runtime's exchange port over the native module. Bytes cross as
 * base64; an answer the module should never give reads as a failure, so a
 * damaged reply is never read as a response or as a refusal.
 */
export function nativePinnedTlsExchangePort(
  native: OctantPinnedTlsNativeModule,
): PinnedListenerExchangePort {
  return {
    resolve: (hostname) => native.resolve(hostname),
    exchange: async (request) => {
      nextExchange += 1;
      const id = `exchange-${nextExchange}`;
      const cancel = () => native.cancel(id);
      request.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const answer = await native.exchange(
          id,
          request.address,
          request.port,
          request.serverName ?? null,
          request.pins,
          toBase64(request.request),
        );
        return readOutcome(answer);
      } finally {
        request.signal?.removeEventListener("abort", cancel);
      }
    },
  };
}

function readOutcome(answer: unknown): PinnedListenerExchangeOutcome {
  const failed = { status: "failed", reason: "connection-failed" } as const;
  if (typeof answer !== "object" || answer === null) return failed;
  const record = answer as Record<string, unknown>;
  const servedPin = typeof record.servedPin === "string" ? record.servedPin : undefined;
  if (record.status === "responded" && servedPin !== undefined) {
    if (typeof record.response !== "string") return failed;
    return { status: "responded", servedPin, response: fromBase64(record.response) };
  }
  if (record.status === "refused") return { status: "refused", servedPin };
  if (
    record.status === "failed" &&
    (record.reason === "unreachable" ||
      record.reason === "handshake-failed" ||
      record.reason === "connection-failed" ||
      record.reason === "too-large")
  ) {
    return { status: "failed", reason: record.reason };
  }
  return failed;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.byteLength; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
