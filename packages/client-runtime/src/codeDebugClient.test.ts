import { describe, expect, it, vi } from "vitest";
import { decodeCodeDebugSessionCall } from "@octant/contracts/code-debug";
import { createCodeDebugClient, CodeDebugClientFailure } from "./codeDebugClient";

const threadId = "20000000-0000-4000-8000-000000000001";
const checkoutId = "30000000-0000-4000-8000-000000000001";
const sessionId = "80000000-0000-4000-8000-000000000001";

function client(respond: () => Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respond());
  return {
    fetch,
    client: createCodeDebugClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "capability",
    }),
  };
}

describe("code debug client", () => {
  it("sends the window capability to the debug route and returns the host's refusal as an answer", async () => {
    const { client: debug, fetch } = client(() =>
      Response.json({ status: "refused", reason: "plan-read-only" }),
    );
    await expect(
      debug.session(
        decodeCodeDebugSessionCall({ threadId, checkoutId, sessionId, request: { kind: "stop" } }),
      ),
    ).resolves.toEqual({ status: "refused", reason: "plan-read-only" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:13773/api/code/debug/session");
    expect(init?.headers).toMatchObject({ "x-octant-window-capability": "capability" });
    expect(JSON.parse(String(init?.body))).toEqual({
      threadId,
      checkoutId,
      sessionId,
      request: { kind: "stop" },
    });
  });

  it("reports the host turning a paired device away as local-only", async () => {
    const { client: debug } = client(() =>
      Response.json(
        { category: "unauthorized", message: "Remote action is not authorized." },
        { status: 403 },
      ),
    );
    await expect(debug.configurations({ threadId, checkoutId } as never)).rejects.toMatchObject({
      kind: "local-only",
    });
  });

  it("refuses a malformed request before sending it, and a non-loopback host over plain HTTP", async () => {
    const { client: debug, fetch } = client(() => Response.json({}));
    await expect(
      debug.start({ threadId, checkoutId, configuration: { name: "" }, breakpoints: [] } as never),
    ).rejects.toBeInstanceOf(CodeDebugClientFailure);
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      createCodeDebugClient({
        baseUrl: "http://octant.example",
        fetch: vi.fn(),
        windowCapability: "capability",
      }),
    ).toThrow(CodeDebugClientFailure);
  });
});
