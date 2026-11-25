import { describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { createMobileAccessActivityClient } from "./accessActivityClient";

const noticeId = "00000000-0000-4000-8000-0000000000a1";

function transportAnswering(answer: (path: string, method: string) => Response) {
  const authenticatedFetch = vi.fn<MobileRemoteTransport["authenticatedFetch"]>(
    async ({ path, method }) => answer(path, method),
  );
  return { transport: { hostId: "host-1", authenticatedFetch }, authenticatedFetch };
}

describe("the phone's access activity client", () => {
  it("reads the activity and notices over the device session without a window capability", async () => {
    const { transport, authenticatedFetch } = transportAnswering((path) =>
      Response.json(path === "/api/access-activity" ? { entries: [] } : { notices: [] }),
    );
    const client = createMobileAccessActivityClient(transport);
    expect(await client.readActivity()).toEqual({ entries: [] });
    expect(await client.readNotices()).toEqual({ notices: [] });
    expect(authenticatedFetch.mock.calls.map(([call]) => [call.method, call.path])).toEqual([
      ["GET", "/api/access-activity"],
      ["GET", "/api/change-notices"],
    ]);
    expect(authenticatedFetch.mock.calls.every(([call]) => call.headers === undefined)).toBe(true);
  });

  it("reads a refusal as nothing and keeps the host's reason for an action it refuses", async () => {
    const { transport, authenticatedFetch } = transportAnswering((path) =>
      path === "/api/change-notices/undo"
        ? Response.json({ message: "That thread changed again." }, { status: 409 })
        : new Response("no", { status: 403 }),
    );
    const client = createMobileAccessActivityClient(transport);
    expect(await client.readActivity()).toBeUndefined();
    expect(await client.act("undo", noticeId)).toEqual({
      status: "refused",
      message: "That thread changed again.",
    });
    const sent = authenticatedFetch.mock.calls.at(-1)?.[0];
    expect(sent).toMatchObject({
      method: "POST",
      path: "/api/change-notices/undo",
      contentType: "application/json",
    });
    expect(JSON.parse(String(sent?.body))).toEqual({ noticeId });
  });
});
