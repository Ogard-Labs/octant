import { describe, expect, it, vi } from "vitest";
import { createProductFeedbackClient, ProductFeedbackClientFailure } from "./productFeedbackClient";

const ids = {
  thread: "22222222-2222-4222-8222-222222222222",
  context: "33333333-3333-4333-8333-333333333333",
  note: "11111111-1111-4111-8111-111111111111",
};

const capability = "window-capability";

function client(fetch: typeof globalThis.fetch) {
  return createProductFeedbackClient({
    baseUrl: "http://127.0.0.1:4319",
    fetch,
    windowCapability: capability,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const capture = {
  kind: "capture-product-feedback",
  threadId: ids.thread,
  mode: "code",
  contextId: ids.context,
  point: { x: 0.5, y: 0.5 },
  comment: "This is misaligned.",
} as const;

describe("the pointed-at feedback client", () => {
  it("asks the host for a thread's notes under the window capability", async () => {
    const fetch = vi.fn(async () => jsonResponse({ notes: [] }));

    expect(await client(fetch as never).list(ids.thread)).toEqual([]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:4319/api/feedback/notes?threadId=${ids.thread}`);
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(capability);
  });

  it("hands back the host's refusal as an answer rather than an error", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ kind: "feedback-refused", reason: "element-unavailable" }),
    );

    expect(await client(fetch as never).execute(capture as never)).toEqual({
      kind: "feedback-refused",
      reason: "element-unavailable",
    });
  });

  it("reports a refused request with the host's status", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "Note has changed." }, 409));

    await expect(client(fetch as never).execute(capture as never)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("refuses a base URL that is not loopback", () => {
    expect(() =>
      createProductFeedbackClient({
        baseUrl: "https://octant.example",
        fetch: vi.fn() as never,
        windowCapability: capability,
      }),
    ).toThrow(ProductFeedbackClientFailure);
  });
});
