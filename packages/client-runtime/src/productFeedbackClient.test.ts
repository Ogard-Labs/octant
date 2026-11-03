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
  it("reads only an authorized note crop and strictly rejects non-image or oversized answers", async () => {
    const transport = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ dataUrl: "data:image/jpeg;base64,/9j/AA==" }));
    const actual = client(transport);
    expect(await actual.readCrop(ids.note)).toBe("data:image/jpeg;base64,/9j/AA==");
    expect(transport.mock.calls[0]?.[0]).toBe(
      `http://127.0.0.1:4319/api/feedback/notes/${ids.note}/crop`,
    );
    expect(
      new Headers(transport.mock.calls[0]?.[1]?.headers).get("x-octant-window-capability"),
    ).toBe(capability);
    for (const dataUrl of [
      "data:text/html;base64,AA==",
      "data:image/jpeg;base64," + "A".repeat(262_144),
    ]) {
      transport.mockResolvedValueOnce(jsonResponse({ dataUrl }));
      await expect(actual.readCrop(ids.note)).rejects.toThrow();
    }
  });

  it.each(["headers", "body"] as const)(
    "settles an unavailable host at the finite %s deadline without retry",
    async (phase) => {
      vi.useFakeTimers();
      try {
        const held = Promise.withResolvers<Response>();
        const response = jsonResponse({ notes: [] });
        const body = Promise.withResolvers<unknown>();
        if (phase === "body") vi.spyOn(response, "json").mockImplementation(() => body.promise);
        const transport = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(() =>
            phase === "headers" ? held.promise : Promise.resolve(response),
          );
        const actual = createProductFeedbackClient({
          baseUrl: "http://127.0.0.1:4319",
          fetch: transport,
          windowCapability: capability,
          requestTimeoutMs: 20,
        });
        const pending = actual.list(ids.thread);
        const refused = expect(pending).rejects.toMatchObject({
          status: 0,
          message: expect.stringContaining("Refresh notes"),
        });
        await vi.advanceTimersByTimeAsync(21);
        await refused;
        expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        expect(transport).toHaveBeenCalledOnce();
        held.resolve(response);
        body.resolve({ notes: [] });
        await vi.runAllTimersAsync();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("settles caller cancellation even if transport ignores abort", async () => {
    const held = Promise.withResolvers<Response>();
    const transport = vi.fn<typeof globalThis.fetch>().mockImplementation(() => held.promise);
    const abort = new AbortController();
    const pending = client(transport).list(ids.thread, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ status: 0 });
    held.resolve(jsonResponse({ notes: [] }));
    expect(transport).toHaveBeenCalledOnce();
  });
});
