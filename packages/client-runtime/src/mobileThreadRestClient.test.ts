import { describe, expect, it } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { setMobileThreadRest, setMobileUsageResume } from "./mobileThreadRestClient";

const threadId = "60000000-0000-4000-8000-000000000001";

function recordingTransport(answer: () => Response) {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport: MobileRemoteTransport = {
    hostId: "11111111-1111-4111-8111-111111111111",
    authenticatedFetch: async ({ path, body }) => {
      sent.push({ path, body: JSON.parse(String(body)) as Record<string, unknown> });
      return answer();
    },
  };
  return { transport, sent };
}

describe("changing a thread's place in the list from the phone", () => {
  it("snoozes a Work thread with the version the phone read", async () => {
    const { transport, sent } = recordingTransport(
      () => new Response(JSON.stringify({ message: "Snoozing is paused." }), { status: 400 }),
    );
    const result = await setMobileThreadRest({
      transport,
      row: { mode: "work", threadId, version: 7 },
      action: { kind: "snooze", until: "2026-11-15T09:00:00.000Z" },
    });
    expect(sent).toEqual([
      {
        path: "/api/work/threads/commands",
        body: {
          kind: "snooze-work-thread",
          threadId,
          expectedVersion: 7,
          until: "2026-11-15T09:00:00.000Z",
        },
      },
    ]);
    expect(result).toEqual({ status: "refused", message: "Snoozing is paused." });
  });

  it("refuses to pin a Chat or Work thread without asking the host, as the desktop has no such pin", async () => {
    const { transport, sent } = recordingTransport(() => new Response("{}"));
    const result = await setMobileThreadRest({
      transport,
      row: { mode: "chat", threadId, version: 1 },
      action: { kind: "pin", pinned: true },
    });
    expect(sent).toEqual([]);
    expect(result.status).toBe("refused");
  });

  it("says the thread changed when the host answers that the version is stale", async () => {
    const { transport } = recordingTransport(() => new Response("{}", { status: 409 }));
    const result = await setMobileThreadRest({
      transport,
      row: { mode: "code", threadId, version: 3 },
      action: { kind: "put-away" },
    });
    expect(result).toEqual({
      status: "refused",
      message: "The thread changed on the host. Refresh and try again.",
    });
  });

  it("binds a Code resume to the stopped operation and a Work resume to the stopped turn", async () => {
    const { transport, sent } = recordingTransport(
      () => new Response(JSON.stringify({ message: "No usage-limited stop." }), { status: 400 }),
    );
    await setMobileUsageResume({
      transport,
      row: { mode: "code", threadId, version: 2 },
      action: { kind: "schedule", turnId: "op-1" },
    });
    await setMobileUsageResume({
      transport,
      row: { mode: "work", threadId, version: 4 },
      action: { kind: "schedule", turnId: "turn-1" },
    });
    expect(sent.map((entry) => entry.body)).toEqual([
      { kind: "schedule-code-usage-resume", operationId: "op-1", threadId, expectedVersion: 2 },
      { kind: "schedule-work-usage-resume", turnId: "turn-1", threadId, expectedVersion: 4 },
    ]);
  });
});
