import { describe, expect, it, vi } from "vitest";
import { createActiveWorkClient } from "./activeWorkClient";

const row = {
  kind: "thread",
  mode: "code",
  threadId: "00000000-0000-4000-8000-000000000021",
  title: "Fix the parser",
  board: { status: "waiting", reason: "awaiting-input" },
  pullRequests: [],
  issues: [],
  updatedAt: "2026-11-25T10:00:00.000Z",
};

function client(respond: () => Promise<Response>) {
  const fetch = vi.fn(respond);
  return {
    fetch,
    read: createActiveWorkClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    }).read,
  };
}

describe("reading one host's active work", () => {
  it("asks that host and keeps what it answered", async () => {
    const { fetch, read } = client(async () => Response.json({ rows: [row], truncated: true }));
    expect(await read()).toEqual({ status: "answered", work: { rows: [row], truncated: true } });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4100/api/active-work", {
      method: "GET",
      headers: { "x-octant-window-capability": "cap" },
    });
  });

  it("keeps the rows it can read when a later host adds a kind or a fact", async () => {
    const { read } = client(async () =>
      Response.json({
        rows: [
          { ...row, kind: "bot" },
          { ...row, mood: "calm" },
        ],
        truncated: false,
        more: 1,
      }),
    );
    expect(await read()).toEqual({ status: "answered", work: { rows: [row], truncated: false } });
  });

  it("tells an older host, a refusal and a host that did not answer apart", async () => {
    const older = client(async () => Response.json({ error: "Not found" }, { status: 404 }));
    expect(await older.read()).toEqual({ status: "unsupported" });
    const refused = client(async () =>
      Response.json({ code: "unauthorized", message: "No." }, { status: 403 }),
    );
    expect(await refused.read()).toEqual({ status: "refused" });
    const failing = client(async () =>
      Response.json({ code: "unavailable", message: "Busy." }, { status: 503 }),
    );
    expect(await failing.read()).toEqual({ status: "unreachable" });
    const offline = client(async () => {
      throw new TypeError("offline");
    });
    expect(await offline.read()).toEqual({ status: "unreachable" });
    const garbled = client(async () => Response.json({ rows: "none" }));
    expect(await garbled.read()).toEqual({ status: "unreachable" });
  });
});
