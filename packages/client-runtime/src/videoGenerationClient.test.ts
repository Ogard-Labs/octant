import { decodeVideoJobId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { createMobileThreadVideos } from "./videoGenerationClient";

const jobId = decodeVideoJobId("b4000000-0000-4000-8000-000000000001");
const ticket = `?ticket=${"a".repeat(43)}`;
const rangeSize = 4 * 1024 * 1024;

function response(first: number, last: number, size: number) {
  const bytes = new Uint8Array(last - first + 1).fill(first === 0 ? 1 : 2);
  return new Response(bytes, {
    status: 206,
    headers: { "content-range": `bytes ${first}-${last}/${size}` },
  });
}

function transport(...ranges: ReadonlyArray<Response>) {
  const authenticatedFetch = vi
    .fn<MobileRemoteTransport["authenticatedFetch"]>()
    .mockResolvedValueOnce(
      Response.json({ url: `/api/video/clip${ticket}`, expiresAt: "2026-11-24T00:30:00.000Z" }),
    );
  for (const range of ranges) authenticatedFetch.mockResolvedValueOnce(range);
  return { hostId: "host", authenticatedFetch };
}

describe("mobile thread video clips", () => {
  it("reads a clip in bounded authenticated byte ranges and writes the parts in order", async () => {
    const size = rangeSize + 2;
    const session = transport(
      response(0, rangeSize - 1, size),
      response(rangeSize, size - 1, size),
    );
    const signal = new AbortController().signal;
    const write = vi.fn((bytes: Uint8Array) => [bytes.length, bytes[0]]);

    await createMobileThreadVideos(session).readClip({ jobId, size, signal, write });

    expect(write.mock.results.map((result) => result.value)).toEqual([
      [rangeSize, 1],
      [2, 2],
    ]);
    expect(session.authenticatedFetch.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/video/clip",
        body: JSON.stringify({ jobId }),
        signal,
      }),
      {
        method: "GET",
        path: "/api/video/clip",
        query: ticket,
        headers: { range: `bytes=0-${rangeSize - 1}` },
        signal,
      },
      {
        method: "GET",
        path: "/api/video/clip",
        query: ticket,
        headers: { range: `bytes=${rangeSize}-${size - 1}` },
        signal,
      },
    ]);
  });

  it("refuses a range whose offset or total does not match the clip", async () => {
    const session = transport(response(1, 2, 3));
    const write = vi.fn();
    const signal = new AbortController().signal;
    await expect(
      createMobileThreadVideos(session).readClip({ jobId, size: 2, signal, write }),
    ).rejects.toThrow(/incomplete/i);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not read another range after the clip is closed", async () => {
    const size = rangeSize + 2;
    const session = transport(response(0, rangeSize - 1, size));
    const controller = new AbortController();
    const write = vi.fn(() => controller.abort());
    await expect(
      createMobileThreadVideos(session).readClip({ jobId, size, signal: controller.signal, write }),
    ).rejects.toThrow();
    expect(session.authenticatedFetch).toHaveBeenCalledTimes(2);
  });
});
