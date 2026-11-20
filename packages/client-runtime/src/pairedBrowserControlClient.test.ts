import {
  decodePairedBrowserChooserId,
  decodePairedBrowserLeaseId,
  type PairedBrowserStreamEvent,
} from "@octant/contracts/paired-browser-control";
import { describe, expect, it, vi } from "vitest";
import { createPairedBrowserControlClient } from "./pairedBrowserControlClient";

const leaseId = decodePairedBrowserLeaseId("11111111-1111-4111-8111-111111111111");
const chooserId = decodePairedBrowserChooserId("22222222-2222-4222-8222-222222222222");

describe("paired browser control client", () => {
  it("streams NDJSON frames and status events and refuses oversized corrupted frames", async () => {
    const events: Array<PairedBrowserStreamEvent> = [];
    const client = createPairedBrowserControlClient({
      fetch: vi.fn(async () => {
        const lines = [
          JSON.stringify({
            kind: "frame",
            frameId: 1,
            documentVersion: "a".repeat(64),
            viewport: { width: 1280, height: 800 },
            devicePixelRatio: 2,
            jpegBase64: "AAAA",
          }),
          JSON.stringify({ kind: "withheld", reason: "private-custody" }),
          JSON.stringify({ kind: "reclaimed-locally" }),
          JSON.stringify({ kind: "ended", reason: "reclaimed-locally" }),
        ].join("\n");
        return new Response(`${lines}\n`, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }),
    });

    expect(await client.stream({ leaseId, onEvent: (event) => events.push(event) })).toEqual({
      status: "ended",
    });
    expect(events.map((event) => event.kind)).toEqual([
      "frame",
      "withheld",
      "reclaimed-locally",
      "ended",
    ]);
  });

  it("sends sequenced touch/keyboard input and chooser file uploads without retrying", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/browser/remote-control/input") {
        return Response.json({ status: "input", lastAcceptedSequence: 1, effect: "completed" });
      }
      return Response.json({ status: "released" });
    });
    const client = createPairedBrowserControlClient({ fetch: fetchMock });

    expect(
      await client.sendInput(leaseId, 1, [
        { kind: "tap", frameId: 1, x: 0.5, y: 0.5 },
        { kind: "text", text: "hello" },
      ]),
    ).toEqual({ status: "input", lastAcceptedSequence: 1, effect: "completed" });

    expect(
      await client.uploadFile({
        leaseId,
        chooserId,
        fileName: "doc.pdf",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "application/pdf",
      }),
    ).toEqual({ status: "released" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
