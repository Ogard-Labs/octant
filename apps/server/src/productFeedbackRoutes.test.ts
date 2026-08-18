import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProductFeedbackError } from "./browser/productFeedbackService";
import { createProductFeedbackRouteHandler } from "./productFeedbackRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const capability = `${"A".repeat(42)}A`;
const threadId = "22222222-2222-4222-8222-222222222222";
const contextId = "33333333-3333-4333-8333-333333333333";

const captureBody = JSON.stringify({
  kind: "capture-product-feedback",
  threadId,
  mode: "code",
  contextId,
  point: { x: 0.5, y: 0.5 },
  comment: "This is misaligned.",
});

function handler(
  overrides: {
    readonly list?: ReturnType<typeof vi.fn>;
    readonly execute?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const list = overrides.list ?? vi.fn(async () => []);
  const execute = overrides.execute ?? vi.fn(async () => ({ kind: "feedback-captured" }));
  return {
    list,
    execute,
    handle: createProductFeedbackRouteHandler({
      windowAuthorityStore: store,
      feedback: { list, execute } as never,
      now: () => 0,
    }),
  };
}

describe("pointed-at feedback routes", () => {
  it("answers a thread's notes to the window that authenticated", async () => {
    const { handle, list } = handler();

    const response = await handle(
      new Request(`http://127.0.0.1/api/feedback/notes?threadId=${threadId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ notes: [] });
    expect(list).toHaveBeenCalledWith(windowId, threadId);
  });

  it("refuses a capture that carries no window capability", async () => {
    const { handle, execute } = handler();

    const response = await handle(
      new Request("http://127.0.0.1/api/feedback/commands", {
        method: "POST",
        body: captureBody,
      }),
    );

    expect(response?.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a capture that did not come from loopback", async () => {
    const { handle, execute } = handler();

    const response = await handle(
      new Request("http://octant.example/api/feedback/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: captureBody,
      }),
    );

    expect(response?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("hands the capture to the service under the authenticated window", async () => {
    const { handle, execute } = handler();

    const response = await handle(
      new Request("http://127.0.0.1/api/feedback/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: captureBody,
      }),
    );

    expect(response?.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(windowId, JSON.parse(captureBody));
  });

  it("reports a note that moved under the caller as a conflict", async () => {
    const { handle } = handler({
      execute: vi.fn(async () => {
        throw new ProductFeedbackError("conflict", "Product feedback note has changed.");
      }),
    });

    const response = await handle(
      new Request("http://127.0.0.1/api/feedback/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: captureBody,
      }),
    );

    expect(response?.status).toBe(409);
  });

  it("leaves paths it does not own to the rest of the server", async () => {
    const { handle } = handler();

    expect(await handle(new Request("http://127.0.0.1/api/browser/scope"))).toBeUndefined();
  });
});
