import { describe, expect, it, vi } from "vitest";
import {
  decideMobileBrowserApproval,
  listMobileBrowserApprovals,
} from "./mobileBrowserApprovalClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const threadId = "00000000-0000-4000-8000-000000000020";
const otherThreadId = "00000000-0000-4000-8000-000000000021";
const approvalId = "00000000-0000-4000-8000-000000000030";

const approval = (thread: string) => ({
  approvalId,
  threadId: thread,
  mode: "work",
  origin: "https://example.com",
  upload: { files: [{ name: "report.pdf", sizeBytes: 12_000 }] },
  requestedAt: "2026-11-25T10:00:00.000Z",
});

function transportReturning(response: () => Response) {
  const authenticatedFetch = vi.fn<MobileRemoteTransport["authenticatedFetch"]>(async () =>
    response(),
  );
  return { transport: { hostId: "host-1", authenticatedFetch }, authenticatedFetch };
}

describe("the phone's Browser approvals", () => {
  it("lists only the open thread's approvals, and throws on a refused read", async () => {
    const { transport, authenticatedFetch } = transportReturning(() =>
      Response.json([approval(threadId), approval(otherThreadId)]),
    );
    const listed = await listMobileBrowserApprovals({ transport, threadId });
    expect(listed.map((entry) => String(entry.threadId))).toEqual([threadId]);
    expect(authenticatedFetch.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      path: "/api/browser/approvals",
      body: JSON.stringify({ kind: "list" }),
    });
    const refused = transportReturning(() => new Response("no", { status: 403 }));
    await expect(
      listMobileBrowserApprovals({ transport: refused.transport, threadId }),
    ).rejects.toThrow();
  });

  it("sends the answer with its remembered scope and tells accepted, settled elsewhere and refused apart", async () => {
    const decision = { approvalId, decision: "approved", remember: true } as never;
    const accepted = transportReturning(() => Response.json({ accepted: true }));
    expect(await decideMobileBrowserApproval({ transport: accepted.transport, decision })).toBe(
      "accepted",
    );
    expect(JSON.parse(String(accepted.authenticatedFetch.mock.calls[0]?.[0].body))).toEqual({
      kind: "decide",
      approvalId,
      decision: "approved",
      remember: true,
    });
    const settled = transportReturning(() => Response.json({ accepted: false }, { status: 409 }));
    expect(await decideMobileBrowserApproval({ transport: settled.transport, decision })).toBe(
      "settled-elsewhere",
    );
    const refused = transportReturning(() => new Response("no", { status: 403 }));
    expect(await decideMobileBrowserApproval({ transport: refused.transport, decision })).toBe(
      "refused",
    );
  });
});
