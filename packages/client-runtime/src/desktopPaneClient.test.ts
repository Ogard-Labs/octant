import { describe, expect, it, vi } from "vitest";
import { decodeDesktopFrameRequest, decodeDesktopPaneRequest } from "@octant/contracts";
import { createDesktopPaneClient, DesktopPaneClientFailure } from "./desktopPaneClient";

const threadId = "70000000-0000-4000-8000-000000000001";
const leaseId = "70000000-0000-4000-8000-000000000002";
const viewId = "70000000-0000-4000-8000-000000000003";
const frameRequest = decodeDesktopFrameRequest({ threadId, leaseId, viewId });

function client(respond: () => Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respond());
  return {
    fetch,
    client: createDesktopPaneClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "capability",
    }),
  };
}

describe("desktop pane client", () => {
  it("sends the request with the window capability and returns the host's answer", async () => {
    const { client: pane, fetch } = client(() =>
      Response.json({ status: "refused", reason: "no-provider-configured" }),
    );
    await expect(
      pane.request(decodeDesktopPaneRequest({ kind: "acquire", threadId })),
    ).resolves.toEqual({ status: "refused", reason: "no-provider-configured" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:13773/api/code/desktops");
    expect(init?.headers).toMatchObject({ "x-octant-window-capability": "capability" });
    expect(JSON.parse(String(init?.body))).toEqual({ kind: "acquire", threadId });
  });

  it("returns a frame as the image, and a refused frame as the host's answer", async () => {
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const shown = client(() => new Response(image, { headers: { "content-type": "image/png" } }));
    const frame = await shown.client.frame(frameRequest);
    expect(frame.status).toBe("frame");
    if (frame.status === "frame") {
      expect(new Uint8Array(await frame.image.arrayBuffer())).toEqual(image);
    }
    const ended = client(() => Response.json({ status: "refused", reason: "view-ended" }));
    await expect(ended.client.frame(frameRequest)).resolves.toEqual({
      status: "refused",
      reason: "view-ended",
    });
  });

  it("refuses a non-loopback host over plain HTTP, and reports a failed request as a failure", async () => {
    expect(() =>
      createDesktopPaneClient({
        baseUrl: "http://octant.example",
        fetch: vi.fn(),
        windowCapability: "capability",
      }),
    ).toThrow(DesktopPaneClientFailure);
    const failing = client(() =>
      Response.json({ message: "Desktop request is unauthorized." }, { status: 401 }),
    );
    await expect(
      failing.client.request(decodeDesktopPaneRequest({ kind: "overview", threadId })),
    ).rejects.toMatchObject({ status: 401, message: "Desktop request is unauthorized." });
  });
});
