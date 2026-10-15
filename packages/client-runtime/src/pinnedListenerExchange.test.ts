import { describe, expect, it, vi } from "vitest";
import {
  createExchangeListenerFetch,
  type PinnedListenerExchangeOutcome,
  type PinnedListenerExchangePort,
  type PinnedListenerExchangeRequest,
} from "./pinnedListenerExchange";
import { ListenerTrustRefused, type ListenerOriginTrust } from "./remoteListenerTrust";

const ORIGIN = "https://100.101.102.103:8443";
const PIN = `sha256-${Buffer.alloc(32, 1).toString("base64url")}`;
const OTHER_PIN = `sha256-${Buffer.alloc(32, 2).toString("base64url")}`;
const PINNED: ListenerOriginTrust = { current: { kind: "pinned", pin: PIN } };

function reply(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

/** An exchange that answers as a listener serving `served` would, recording what was written. */
function listener(input: {
  readonly served: string;
  readonly response?: Uint8Array;
  readonly addresses?: ReadonlyArray<string>;
}) {
  const sent: PinnedListenerExchangeRequest[] = [];
  const port: PinnedListenerExchangePort = {
    resolve: vi.fn(async () => input.addresses ?? []),
    exchange: vi.fn(async (request): Promise<PinnedListenerExchangeOutcome> => {
      if (!request.pins.includes(input.served)) {
        return { status: "refused", servedPin: input.served };
      }
      sent.push(request);
      return {
        status: "responded",
        servedPin: input.served,
        response:
          input.response ??
          reply(
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}',
          ),
      };
    }),
  };
  return { port, sent };
}

async function refusalOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ListenerTrustRefused) return error.reason;
    throw error;
  }
  return undefined;
}

describe("a listener fetch over the phone's pinned exchange", () => {
  it("refuses a listener serving another key, and writes no request", async () => {
    const host = listener({ served: OTHER_PIN });
    const fetch = createExchangeListenerFetch({ origin: ORIGIN, trust: PINNED, port: host.port });

    await expect(refusalOf(fetch(`${ORIGIN}/api/remote/hello`))).resolves.toBe("pin-mismatch");
    expect(host.sent).toEqual([]);
  });

  it("sends a framed request only to the judged address under the pinned key, and reads the reply", async () => {
    const host = listener({ served: PIN });
    const fetch = createExchangeListenerFetch({ origin: ORIGIN, trust: PINNED, port: host.port });

    const response = await fetch(`${ORIGIN}/api/remote/pairing/claim?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.example", connection: "upgrade" },
      body: '{"label":"Ada’s phone"}',
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(host.sent).toHaveLength(1);
    const sent = host.sent[0];
    expect(sent).toMatchObject({
      address: "100.101.102.103",
      port: 8443,
      serverName: undefined,
      pins: [PIN],
    });
    const text = Buffer.from(sent?.request ?? new Uint8Array()).toString("utf8");
    expect(text).toBe(
      [
        "POST /api/remote/pairing/claim?x=1 HTTP/1.1",
        "Host: 100.101.102.103:8443",
        "content-type: application/json",
        "Connection: close",
        `Content-Length: ${Buffer.byteLength('{"label":"Ada’s phone"}')}`,
        "",
        '{"label":"Ada’s phone"}',
      ].join("\r\n"),
    );
    expect(host.port.resolve).not.toHaveBeenCalled();
  });

  it("never asks the exchange to reach an origin with no pin, and never uses the platform fetch", async () => {
    const host = listener({ served: PIN });
    const platformFetch = vi.spyOn(globalThis, "fetch");
    const fetch = createExchangeListenerFetch({
      origin: ORIGIN,
      trust: { current: { kind: "platform" } },
      port: host.port,
    });

    await expect(refusalOf(fetch(`${ORIGIN}/api/remote/hello`))).resolves.toBe(
      "platform-untrusted",
    );
    expect(host.port.exchange).not.toHaveBeenCalled();
    expect(platformFetch).not.toHaveBeenCalled();
    platformFetch.mockRestore();
  });

  it("says a newer Octant is needed for a pin naming another hash, without connecting", async () => {
    const host = listener({ served: PIN });
    const fetch = createExchangeListenerFetch({
      origin: ORIGIN,
      trust: { current: { kind: "pinned", pin: "sha512-AAAA" } },
      port: host.port,
    });

    await expect(refusalOf(fetch(`${ORIGIN}/`))).resolves.toBe("newer-version");
    expect(host.port.exchange).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to any public address before dialling", async () => {
    const host = listener({ served: PIN, addresses: ["100.101.102.103", "203.0.113.7"] });
    const fetch = createExchangeListenerFetch({
      origin: "https://studio.tail1234.ts.net:8443",
      trust: PINNED,
      port: host.port,
    });

    await expect(refusalOf(fetch("https://studio.tail1234.ts.net:8443/"))).resolves.toBe(
      "not-private-address",
    );
    expect(host.port.exchange).not.toHaveBeenCalled();
  });

  it("dials the resolved private address for a named origin and sends the name for the handshake", async () => {
    const host = listener({ served: PIN, addresses: ["100.101.102.103"] });
    const fetch = createExchangeListenerFetch({
      origin: "https://studio.tail1234.ts.net:8443",
      trust: PINNED,
      port: host.port,
    });

    await fetch("https://studio.tail1234.ts.net:8443/api/remote/hello");

    expect(host.sent[0]).toMatchObject({
      address: "100.101.102.103",
      serverName: "studio.tail1234.ts.net",
    });
  });

  it("accepts a staged key only inside its window", async () => {
    const now = Date.parse("2026-10-15T12:00:00.000Z");
    const staged = (until: string): ListenerOriginTrust => ({
      current: { kind: "pinned", pin: PIN },
      staged: { trust: { kind: "pinned", pin: OTHER_PIN }, until },
    });
    const live = listener({ served: OTHER_PIN });
    const ended = listener({ served: OTHER_PIN });

    await createExchangeListenerFetch({
      origin: ORIGIN,
      trust: staged("2026-10-20T12:00:00.000Z"),
      port: live.port,
      now: () => now,
    })(`${ORIGIN}/`);
    const refused = refusalOf(
      createExchangeListenerFetch({
        origin: ORIGIN,
        trust: staged("2026-10-15T11:00:00.000Z"),
        port: ended.port,
        now: () => now,
      })(`${ORIGIN}/`),
    );

    expect(live.sent).toHaveLength(1);
    await expect(refused).resolves.toBe("pin-mismatch");
  });

  it("refuses a URL on another origin", async () => {
    const host = listener({ served: PIN });
    const fetch = createExchangeListenerFetch({ origin: ORIGIN, trust: PINNED, port: host.port });

    await expect(fetch("https://100.101.102.103:8444/")).rejects.toBeInstanceOf(TypeError);
    await expect(fetch(`${ORIGIN}.evil.example/`)).rejects.toBeInstanceOf(TypeError);
    expect(host.port.exchange).not.toHaveBeenCalled();
  });

  it("reads a chunked reply and hands a redirect back without following it", async () => {
    const chunked = listener({
      served: PIN,
      response: reply(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n",
      ),
    });
    const redirect = listener({
      served: PIN,
      response: reply(
        "HTTP/1.1 302 Found\r\nLocation: https://203.0.113.7/\r\nContent-Length: 0\r\n\r\n",
      ),
    });

    const text = await createExchangeListenerFetch({
      origin: ORIGIN,
      trust: PINNED,
      port: chunked.port,
    })(`${ORIGIN}/`).then((response) => response.text());
    const moved = await createExchangeListenerFetch({
      origin: ORIGIN,
      trust: PINNED,
      port: redirect.port,
    })(`${ORIGIN}/`);

    expect(text).toBe("Wikipedia");
    expect(moved.status).toBe(302);
    expect(redirect.port.exchange).toHaveBeenCalledTimes(1);
  });

  it("refuses a reply cut short rather than reading part of it as the whole", async () => {
    const short = listener({
      served: PIN,
      response: reply('HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{"ok":'),
    });
    const brokenChunks = listener({
      served: PIN,
      response: reply("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\nWiki"),
    });

    for (const host of [short, brokenChunks]) {
      await expect(
        createExchangeListenerFetch({ origin: ORIGIN, trust: PINNED, port: host.port })(
          `${ORIGIN}/`,
        ),
      ).rejects.toThrow("The listener sent a reply Octant cannot read.");
    }
  });

  it("stops before connecting when the request was already aborted", async () => {
    const host = listener({ served: PIN });
    const controller = new AbortController();
    controller.abort();

    await expect(
      createExchangeListenerFetch({ origin: ORIGIN, trust: PINNED, port: host.port })(
        `${ORIGIN}/`,
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toBeDefined();
    expect(host.port.exchange).not.toHaveBeenCalled();
  });
});
