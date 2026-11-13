import { defaultShellSettings } from "@octant/domain/shell-policy";
import { describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { createReplyDetailClient, readMobileReplyDetail } from "./replyDetailClient";

type FetchInput = Parameters<MobileRemoteTransport["authenticatedFetch"]>[0];

const reading = {
  defaultLevel: "medium",
  threads: [{ mode: "work", threadId: "thread-1", level: "high" }],
} as const;

function transportAnswering(answer: () => Response) {
  const fetch = vi.fn(async (_input: FetchInput) => answer());
  const transport: MobileRemoteTransport = {
    hostId: "77000000-0000-4000-8000-0000000000ff",
    authenticatedFetch: fetch,
  };
  return { transport, fetch };
}

describe("reading the host's reply detail from a paired client", () => {
  it("reads the default and the threads' own levels with one GET", async () => {
    const host = transportAnswering(() => Response.json(reading));
    await expect(readMobileReplyDetail({ transport: host.transport })).resolves.toEqual(reading);
    expect(host.fetch.mock.calls[0]?.[0]).toEqual({ method: "GET", path: "/api/reply-detail" });
  });

  it("reads nothing, so the quiet default draws, when the host refuses or answers off-contract", async () => {
    for (const answer of [
      () => new Response(null, { status: 404 }),
      () => Response.json({ defaultLevel: "verbose", threads: [] }),
      () => {
        throw new Error("offline");
      },
    ]) {
      await expect(
        readMobileReplyDetail({ transport: transportAnswering(answer).transport }),
      ).resolves.toBeUndefined();
    }
  });

  it("reads over a paired browser's product fetch", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(reading),
    );
    const client = createReplyDetailClient({ baseUrl: "http://127.0.0.1", fetch });
    await expect(client.read()).resolves.toEqual(reading);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1/api/reply-detail");
  });

  it("sets a thread's level by replacing the host's shell settings at the version it read", async () => {
    const settings = { ...defaultShellSettings(), threadReplyDetail: reading.threads };
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({
            kind: "settings-replaced",
            settings: JSON.parse(String(init.body)).settings,
            version: 8,
          })
        : Response.json({ settings, version: 7 }),
    );
    const client = createReplyDetailClient({ baseUrl: "http://127.0.0.1", fetch });
    await expect(
      client.setThreadLevel({ mode: "code", threadId: "thread-2" }, "low"),
    ).resolves.toEqual({
      defaultLevel: settings.replyDetail,
      threads: [...reading.threads, { mode: "code", threadId: "thread-2", level: "low" }],
    });
    expect(String(fetch.mock.calls[1]?.[0])).toBe("http://127.0.0.1/api/shell/settings");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      expectedVersion: 7,
    });
  });

  it("changes nothing a caller can see when the host refuses the shell settings", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 403 }));
    const client = createReplyDetailClient({ baseUrl: "http://127.0.0.1", fetch });
    await expect(
      client.setThreadLevel({ mode: "code", threadId: "thread-2" }, "low"),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
