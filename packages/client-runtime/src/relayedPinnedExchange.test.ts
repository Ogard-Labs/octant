import { RELAY_OPENED_MESSAGE } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { createExchangeListenerFetch } from "./pinnedListenerExchange";
import { createRelayedExchangePort, type PinnedTlsStreamEvent } from "./relayedPinnedExchange";
import { ListenerUnreachable } from "./remoteListenerTrust";
import type { RelayWebSocketConstructor } from "./relayTunnel";

const ORIGIN = "https://laptop.tail1234.ts.net:8443";
const PIN = `sha256-${"A".repeat(43)}`;
const HOST = "22222222-2222-4222-8222-222222222222";
const HUB = "11111111-1111-4111-8111-111111111111";

/** A hub that admits every device, as far as the tunnel's own messages go. */
class AdmittingSocket extends EventTarget {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  binaryType = "blob";
  readyState = 1;

  constructor() {
    super();
    queueMicrotask(() =>
      this.#say(JSON.stringify({ challenge: "A".repeat(43), hubMemberId: HUB })),
    );
  }

  send(data: unknown): void {
    if (typeof data === "string") queueMicrotask(() => this.#say(RELAY_OPENED_MESSAGE));
  }

  close(): void {
    this.readyState = 3;
  }

  #say(data: string): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
}

function through(events: ReadonlyArray<PinnedTlsStreamEvent>) {
  const queued = [...events];
  return createExchangeListenerFetch({
    origin: ORIGIN,
    trust: { current: { kind: "pinned", pin: PIN } },
    throughRelay: true,
    port: createRelayedExchangePort({
      route: {
        url: "wss://hub.example.com/relay/v1",
        targetMemberId: HOST,
        admit: async () => ({ signature: "s".repeat(86), deviceSpki: "k".repeat(91) }),
      },
      WebSocket: AdmittingSocket as unknown as RelayWebSocketConstructor,
      stream: {
        open: () => undefined,
        push: () => undefined,
        pushEnd: () => undefined,
        pull: async () => queued.shift() ?? { status: "end" },
        cancel: () => undefined,
      },
    }),
  });
}

describe("a request through the relay that fails while opening", () => {
  const failure = (events: ReadonlyArray<PinnedTlsStreamEvent>): Promise<unknown> =>
    through(events)(`${ORIGIN}/api/work/turns`, { method: "POST", body: "{}" }).then(
      () => undefined,
      (error: unknown) => error,
    );

  it("may have been sent once the stream lost its connection", async () => {
    const sent = { status: "send", chunk: new Uint8Array([1]) } as const;
    for (const events of [
      [sent, { status: "failed", reason: "connection-failed" } as const],
      // The module forgot a cancelled stream, whose queued bytes already left.
      [sent, { status: "end" } as const],
    ]) {
      const error = await failure(events);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(ListenerUnreachable);
    }
  });

  it("was never sent when the handshake failed", async () => {
    expect(await failure([{ status: "failed", reason: "handshake-failed" }])).toBeInstanceOf(
      ListenerUnreachable,
    );
  });
});

describe("a request given up on while the hub is admitting the device", () => {
  it("closes the tunnel and sends nothing through it", async () => {
    const controller = new AbortController();
    const opened: string[] = [];
    const sockets: AdmittingSocket[] = [];
    class WatchedSocket extends AdmittingSocket {
      constructor() {
        super();
        sockets.push(this);
      }
    }
    const port = createRelayedExchangePort({
      route: {
        url: "wss://hub.example.com/relay/v1",
        targetMemberId: HOST,
        admit: async () => {
          controller.abort();
          return { signature: "s".repeat(86), deviceSpki: "k".repeat(91) };
        },
      },
      WebSocket: WatchedSocket as unknown as RelayWebSocketConstructor,
      stream: {
        open: (id) => void opened.push(id),
        push: () => undefined,
        pushEnd: () => undefined,
        pull: async () => ({ status: "end" }),
        cancel: () => undefined,
      },
    });

    const opening = await port.open({
      address: "laptop.tail1234.ts.net",
      port: 8443,
      serverName: undefined,
      pins: [PIN],
      request: new TextEncoder().encode("POST /api/work/turns HTTP/1.1\r\n\r\n"),
      signal: controller.signal,
    });

    expect(opening).toEqual({ status: "failed", reason: "connection-failed" });
    expect(opened).toEqual([]);
    expect(sockets.map((socket) => socket.readyState)).toEqual([3]);
  });
});
