import { describe, expect, it, vi } from "vitest";
import {
  nativePinnedTlsExchangePort,
  type OctantPinnedTlsNativeModule,
} from "./pinnedTlsExchangePort";

const PIN = `sha256-${Buffer.alloc(32, 1).toString("base64url")}`;

function nativeAnswering(answer: unknown) {
  const native: OctantPinnedTlsNativeModule = {
    resolve: vi.fn(async () => []),
    exchange: vi.fn(async () => answer),
    cancel: vi.fn(),
  };
  return native;
}

const request = (signal?: AbortSignal) => ({
  address: "100.101.102.103",
  port: 8443,
  serverName: undefined,
  pins: [PIN],
  request: new Uint8Array(Buffer.from("GET / HTTP/1.1\r\n\r\n")),
  signal,
});

describe("the phone's native pinned exchange", () => {
  it("hands the module the judged address, the pins, and the request bytes, and reads its reply", async () => {
    const native = nativeAnswering({
      status: "responded",
      servedPin: PIN,
      response: Buffer.from("HTTP/1.1 204 No Content\r\n\r\n").toString("base64"),
    });

    const outcome = await nativePinnedTlsExchangePort(native).exchange(request());

    expect(native.exchange).toHaveBeenCalledWith(
      expect.any(String),
      "100.101.102.103",
      8443,
      null,
      [PIN],
      Buffer.from("GET / HTTP/1.1\r\n\r\n").toString("base64"),
    );
    expect(outcome).toEqual({
      status: "responded",
      servedPin: PIN,
      response: new Uint8Array(Buffer.from("HTTP/1.1 204 No Content\r\n\r\n")),
    });
  });

  it("reads a damaged answer as a failure, never as a response", async () => {
    for (const answer of [
      null,
      { status: "responded", response: "AAAA" },
      { status: "responded", servedPin: PIN },
      { status: "accepted" },
      { status: "failed", reason: "something-else" },
    ]) {
      await expect(
        nativePinnedTlsExchangePort(nativeAnswering(answer)).exchange(request()),
      ).resolves.toEqual({ status: "failed", reason: "connection-failed" });
    }
  });

  it("cancels the native exchange when the request is aborted", async () => {
    const controller = new AbortController();
    let finish: (value: unknown) => void = () => undefined;
    const native: OctantPinnedTlsNativeModule = {
      resolve: vi.fn(async () => []),
      exchange: vi.fn(() => new Promise((resolve) => (finish = resolve))),
      cancel: vi.fn(),
    };

    const pending = nativePinnedTlsExchangePort(native).exchange(request(controller.signal));
    controller.abort();
    finish({ status: "failed", reason: "connection-failed" });
    await pending;

    const id = vi.mocked(native.exchange).mock.calls[0]?.[0];
    expect(native.cancel).toHaveBeenCalledWith(id);
  });
});
