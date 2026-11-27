// The phone's pinned exchange through the hub's device relay (decision H36).
// The native module runs the same pinned TLS as on the direct path, but over
// bytes this side carries: its ciphertext comes out as `send` events, which
// go into the relay tunnel, and what the tunnel brings back goes in. So the
// pin check runs inside the relay exactly as at home, and the shared HTTP
// framing and signed-hello check above it are unchanged.

import type {
  PinnedListenerExchangeOpening,
  PinnedListenerExchangePort,
  PinnedListenerExchangeRead,
} from "./pinnedListenerExchange";
import {
  openRelayTunnel,
  type ListenerRelayRoute,
  type RelayWebSocketConstructor,
} from "./relayTunnel";

/** One event of a native TLS stream over app-carried bytes. */
export type PinnedTlsStreamEvent =
  | { readonly status: "send"; readonly chunk: Uint8Array<ArrayBuffer> }
  | { readonly status: "opened"; readonly servedPin: string }
  | { readonly status: "refused"; readonly servedPin?: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "data"; readonly chunk: Uint8Array<ArrayBuffer> }
  | { readonly status: "end" };

/** The native side: a TLS stream that judges the served key against the pins and writes the request only after. */
export interface PinnedTlsStreamPort {
  readonly open: (
    id: string,
    input: { readonly pins: ReadonlyArray<string>; readonly request: Uint8Array },
  ) => void;
  readonly push: (id: string, chunk: Uint8Array) => void;
  readonly pushEnd: (id: string) => void;
  /** The stream's next event, in order. */
  readonly pull: (id: string) => Promise<PinnedTlsStreamEvent>;
  readonly cancel: (id: string) => void;
}

let nextStream = 0;

/**
 * An exchange port whose connection is a relay tunnel to `route`'s host. The
 * address and port it is given are not dialled: the hub carries the bytes,
 * so `createExchangeListenerFetch` is made with `throughRelay`.
 */
export function createRelayedExchangePort(input: {
  readonly stream: PinnedTlsStreamPort;
  readonly route: ListenerRelayRoute;
  readonly WebSocket?: RelayWebSocketConstructor;
}): PinnedListenerExchangePort {
  return {
    resolve: async () => {
      throw new TypeError("A relayed exchange resolves nothing.");
    },
    open: async (request): Promise<PinnedListenerExchangeOpening> => {
      if (request.signal?.aborted === true)
        return { status: "failed", reason: "connection-failed" };
      nextStream += 1;
      const id = `relay-${nextStream}`;
      const tunnel = await openRelayTunnel(
        input.route,
        {
          data: (bytes) => input.stream.push(id, bytes),
          end: () => input.stream.pushEnd(id),
        },
        input.WebSocket,
      );
      if (tunnel === undefined) return { status: "failed", reason: "unreachable" };
      const close = (): void => {
        input.stream.cancel(id);
        tunnel.close();
      };
      const abort = (): void => close();
      request.signal?.addEventListener("abort", abort, { once: true });
      input.stream.open(id, { pins: request.pins, request: request.request });
      try {
        for (;;) {
          const event = await input.stream.pull(id);
          if (event.status === "send") {
            tunnel.send(event.chunk);
            continue;
          }
          if (event.status === "opened") {
            return {
              status: "opened",
              servedPin: event.servedPin,
              read: async (): Promise<PinnedListenerExchangeRead> => {
                for (;;) {
                  const next = await input.stream.pull(id);
                  if (next.status === "send") {
                    tunnel.send(next.chunk);
                    continue;
                  }
                  if (next.status === "data") return { status: "data", chunk: next.chunk };
                  tunnel.close();
                  return next.status === "end" ? { status: "end" } : { status: "failed" };
                }
              },
              close,
            };
          }
          close();
          if (event.status === "refused") return { status: "refused", servedPin: event.servedPin };
          // Nothing was written before the handshake passed; a carrier that
          // ended first is the hub or the host going away.
          return {
            status: "failed",
            reason:
              event.status === "failed" && event.reason === "handshake-failed"
                ? "handshake-failed"
                : "unreachable",
          };
        }
      } finally {
        request.signal?.removeEventListener("abort", abort);
      }
    },
  };
}
