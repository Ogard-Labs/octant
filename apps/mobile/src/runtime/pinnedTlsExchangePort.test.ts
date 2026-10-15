import { describe, expect, it, vi } from "vitest";
import {
  nativePinnedTlsExchangePort,
  type OctantPinnedTlsNativeModule,
} from "./pinnedTlsExchangePort";

const PIN = `sha256-${Buffer.alloc(32, 1).toString("base64url")}`;

function nativeAnswering(opening: unknown, reads: ReadonlyArray<unknown> = []) {
  const queue = [...reads];
  const native: OctantPinnedTlsNativeModule = {
    resolve: vi.fn(async () => []),
    open: vi.fn(async () => opening),
    read: vi.fn(async () => queue.shift()),
    cancel: vi.fn(),
  };
  return native;
}

const request = {
  address: "100.101.102.103",
  port: 8443,
  serverName: undefined,
  pins: [PIN],
  request: new Uint8Array(Buffer.from("GET / HTTP/1.1\r\n\r\n")),
};

describe("the phone's native pinned exchange", () => {
  it("hands the module the judged address, the pins, and the request bytes, then reads the reply chunk by chunk", async () => {
    const native = nativeAnswering({ status: "opened", servedPin: PIN }, [
      { status: "data", chunk: Buffer.from("HTTP/1.1 ").toString("base64") },
      { status: "end" },
    ]);

    const opening = await nativePinnedTlsExchangePort(native).open(request);
    if (opening.status !== "opened") throw new Error(opening.status);

    expect(native.open).toHaveBeenCalledWith(
      expect.any(String),
      "100.101.102.103",
      8443,
      null,
      [PIN],
      Buffer.from("GET / HTTP/1.1\r\n\r\n").toString("base64"),
    );
    await expect(opening.read()).resolves.toEqual({
      status: "data",
      chunk: new Uint8Array(Buffer.from("HTTP/1.1 ")),
    });
    await expect(opening.read()).resolves.toEqual({ status: "end" });
    const id = vi.mocked(native.open).mock.calls[0]?.[0];
    opening.close();
    expect(native.cancel).toHaveBeenCalledWith(id);
  });

  it("reads a damaged answer as a failure, never as an opening or reply bytes", async () => {
    for (const answer of [
      null,
      { status: "opened" },
      { status: "accepted", servedPin: PIN },
      { status: "failed", reason: "something-else" },
    ]) {
      await expect(
        nativePinnedTlsExchangePort(nativeAnswering(answer)).open(request),
      ).resolves.toEqual({
        status: "failed",
        reason: "connection-failed",
      });
    }
    const opened = await nativePinnedTlsExchangePort(
      nativeAnswering({ status: "opened", servedPin: PIN }, [{ status: "data", chunk: 7 }, null]),
    ).open(request);
    if (opened.status !== "opened") throw new Error(opened.status);
    await expect(opened.read()).resolves.toEqual({ status: "failed" });
    await expect(opened.read()).resolves.toEqual({ status: "failed" });
  });

  it("passes a refusal through with the key the listener served", async () => {
    await expect(
      nativePinnedTlsExchangePort(nativeAnswering({ status: "refused", servedPin: PIN })).open(
        request,
      ),
    ).resolves.toEqual({ status: "refused", servedPin: PIN });
  });
});
