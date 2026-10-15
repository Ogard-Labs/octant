import { describe, expect, it, vi } from "vitest";
import {
  decideMobileExtensionToolApproval,
  listMobileExtensionToolApprovals,
} from "./mobileExtensionToolApprovalClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const threadId = "66000000-0000-4000-8000-000000000001";

function approval(approvalId: string, thread: string) {
  return {
    approvalId,
    threadId: thread,
    extensionId: "66000000-0000-4000-8000-00000000000a",
    packageId: "66000000-0000-4000-8000-00000000000b",
    componentId: "server",
    serverName: "notes",
    providerToolName: "plugin__notes__search",
    mcpToolName: "search",
    inputJson: "{}",
    requestedAt: "2026-10-15T06:00:00.000Z",
    rememberable: false,
  };
}

describe("MCP tool prompts on a paired device", () => {
  it("lists only the open thread's prompts and answers approve once without asking to remember", async () => {
    const fetch = vi.fn(async ({ body }: { body?: string | Uint8Array }) => {
      const parsed = JSON.parse(String(body)) as { kind: string };
      return parsed.kind === "list"
        ? Response.json([
            approval("66000000-0000-4000-8000-000000000010", threadId),
            approval(
              "66000000-0000-4000-8000-000000000011",
              "66000000-0000-4000-8000-000000000002",
            ),
          ])
        : Response.json({ accepted: true });
    });
    const transport = {
      hostId: "66000000-0000-4000-8000-0000000000ff",
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    const listed = await listMobileExtensionToolApprovals({ transport, threadId });
    expect(listed.map((entry) => String(entry.approvalId))).toEqual([
      "66000000-0000-4000-8000-000000000010",
    ]);
    await expect(
      decideMobileExtensionToolApproval({
        transport,
        approvalId: "66000000-0000-4000-8000-000000000010",
        decision: "approved",
      }),
    ).resolves.toBe("accepted");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[0].body))).toEqual({
      kind: "decide",
      approvalId: "66000000-0000-4000-8000-000000000010",
      decision: "approved",
    });
  });

  it("reports a refused answer, and lists nothing when the host refuses the list", async () => {
    const transport = {
      hostId: "66000000-0000-4000-8000-0000000000ff",
      authenticatedFetch: (async () =>
        Response.json(
          { accepted: false },
          { status: 409 },
        )) as MobileRemoteTransport["authenticatedFetch"],
    };
    await expect(listMobileExtensionToolApprovals({ transport, threadId })).resolves.toEqual([]);
    await expect(
      decideMobileExtensionToolApproval({
        transport,
        approvalId: "66000000-0000-4000-8000-000000000010",
        decision: "denied",
      }),
    ).resolves.toBe("refused");
  });
});
