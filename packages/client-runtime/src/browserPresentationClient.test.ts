import { describe, expect, it, vi } from "vitest";
import {
  decodeHumanBrowserRequest,
  MAX_HUMAN_FRAME_BYTES,
} from "@octant/contracts/browser-presentation";
import { createBrowserPresentationClient } from "./browserPresentationClient";

const request = decodeHumanBrowserRequest({
  kind: "attach",
  contextId: "00000000-0000-4000-8000-000000000701",
  threadId: "00000000-0000-4000-8000-000000000702",
});
function client(fetch: typeof globalThis.fetch) {
  return createBrowserPresentationClient({
    baseUrl: "http://127.0.0.1:13773",
    windowCapability: "fixture-capability",
    rendererIdentity: "fixture-main-identity",
    fetch,
  });
}

describe("human Browser main client", () => {
  it("uses only its closed host route and main-only identity header", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "idle" }));
    await expect(client(fetch).execute(request)).resolves.toEqual({ status: "idle" });
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/browser/human-presentation"),
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": "fixture-capability",
          "x-octant-human-presentation": "fixture-main-identity",
        },
      }),
    );
    expect(() =>
      createBrowserPresentationClient({
        baseUrl: "https://example.com",
        windowCapability: "fixture",
        rendererIdentity: "fixture",
        fetch,
      }),
    ).toThrow();
  });

  it("stops oversized response bytes before JSON allocation and cancels the reader", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(MAX_HUMAN_FRAME_BYTES));
      },
      cancel,
    });
    await expect(client(async () => new Response(body)).execute(request)).resolves.toEqual({
      status: "refused",
    });
    expect(pulls).toBeLessThanOrEqual(4);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("settles an aborted stalled body without waiting for producer cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const abort = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const result = client(async () => response).execute(request, abort.signal);
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    abort.abort();
    await expect(result).resolves.toEqual({ status: "refused" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not decode a truncated response as a valid frame", async () => {
    await expect(
      client(async () => new Response('{"status":"frame"')).execute(request),
    ).rejects.toThrow();
  });
});
