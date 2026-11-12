import { describe, expect, it, vi } from "vitest";
import { sendAgentAccessRequest } from "./agentAccessControls";

function runtime(fetch: typeof globalThis.fetch) {
  return {
    serverUrl: "http://127.0.0.1:47401",
    desktopBridgeSecret: "secret",
    windowCapability: "capability",
    fetch,
  };
}

describe("Settings › Agent access requests", () => {
  it("forwards a window's command with the desktop secret and its capability", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ kind: "done" });
    };
    const command = {
      kind: "revoke",
      grantId: "62000000-0000-4000-8000-000000000001",
      stopRunningTurns: false,
    };
    const answer = await sendAgentAccessRequest(runtime(fetch), { kind: "command", command });
    expect(answer).toEqual({ status: 200, body: { kind: "done" } });
    expect(calls[0]?.url).toBe("http://127.0.0.1:47401/api/desktop/agent-access/commands");
    expect(calls[0]?.init?.headers).toMatchObject({
      "x-octant-desktop-secret": "secret",
      "x-octant-window-capability": "capability",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(command);
  });

  it("refuses a command the contract does not describe before the host sees it", async () => {
    const fetch = vi.fn(async () => Response.json({ kind: "done" }));
    const answer = await sendAgentAccessRequest(runtime(fetch), {
      kind: "command",
      command: { kind: "revoke", grantId: "not-a-grant", stopRunningTurns: false, extra: 1 },
    });
    expect(answer.status).toBe(400);
    expect(
      await sendAgentAccessRequest(runtime(fetch), { kind: "delete-everything" }),
    ).toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
