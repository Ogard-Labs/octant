import { describe, it, expect, vi } from "vitest";
import { createCommandCredentialsClient } from "./commandCredentialsClient";
const view = { kind: "command-credential-view", bindings: [], requests: [], receipts: [] };
describe("local command binding transport", () => {
  it("sends current window capability and exact Project/thread scope without following redirects", async () => {
    const fetch = vi.fn(async () => Response.json(view));
    const client = createCommandCredentialsClient({
      baseUrl: "http://127.0.0.1:13773",
      windowCapability: "fixture-capability",
      fetch,
    });
    expect(await client.read("project", undefined, "thread")).toEqual(view);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:13773/api/secret-stores/command-bindings?projectId=project&threadId=thread",
      expect.objectContaining({
        redirect: "error",
        cache: "no-store",
        headers: { "x-octant-window-capability": "fixture-capability" },
      }),
    );
  });
  it("refuses remote hosts and excess response fields", async () => {
    expect(() =>
      createCommandCredentialsClient({
        baseUrl: "https://remote.example",
        windowCapability: "fixture",
        fetch: vi.fn(),
      }),
    ).toThrow();
    const client = createCommandCredentialsClient({
      baseUrl: "http://localhost",
      windowCapability: "fixture",
      fetch: vi.fn(async () => Response.json({ ...view, value: "must-not-enter" })),
    });
    expect(client.read()).rejects.toThrow();
  });
});
