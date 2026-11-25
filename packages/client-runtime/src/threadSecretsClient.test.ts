import { describe, expect, it, vi } from "vitest";
import { createThreadSecretsClient } from "./threadSecretsClient";

const client = (fetch: typeof globalThis.fetch) =>
  createThreadSecretsClient({
    baseUrl: "http://127.0.0.1:13773",
    fetch,
    windowCapability: "capability",
  });
const revoke = {
  kind: "revoke",
  threadId: "thread",
  secretId: "00000000-0000-4000-8000-000000000001",
} as const;

describe("thread secrets client", () => {
  it.each(["https://octant.example", "http://octant.example", "http://user:pass@127.0.0.1"])(
    "refuses a host that is not this machine (%s)",
    (baseUrl) => {
      expect(() =>
        createThreadSecretsClient({ baseUrl, fetch: vi.fn(), windowCapability: "capability" }),
      ).toThrow();
    },
  );

  it("reads one thread and the whole host with the window capability, following no redirect", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      Response.json(
        String(url).includes("threadId")
          ? { requests: [], active: [] }
          : { active: [], remembered: [] },
      ),
    );
    expect(await client(fetch).read("thread")).toEqual({ requests: [], active: [] });
    expect(await client(fetch).readHost()).toEqual({ active: [], remembered: [] });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:13773/api/thread-secrets?threadId=thread",
      "http://127.0.0.1:13773/api/thread-secrets",
    ]);
    expect(fetch).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        redirect: "error",
        cache: "no-store",
        headers: { "x-octant-window-capability": "capability" },
      }),
    );
  });

  it("tells an answer the host did not take from one whose outcome is not known", async () => {
    const answered = (status: number) =>
      client(vi.fn(async () => Response.json({ status: "accepted" }, { status }))).execute(revoke);
    expect(await answered(200)).toEqual({ status: "accepted" });
    expect(await answered(401)).toEqual({ status: "not-taken" });
    await expect(answered(502)).rejects.toThrow();
  });

  it("shows nothing it cannot read", async () => {
    const odd = vi.fn(async () =>
      Response.json({ active: [], remembered: [], value: "must-not-pass" }),
    );
    await expect(client(odd).readHost()).rejects.toThrow();
  });
});
