import { describe, expect, it, vi } from "vitest";
import { sendSshTargetOperation, SshTargetControlFailure } from "./sshTargetControls";

function runtime(respond: (url: string, init: RequestInit | undefined) => Response) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  return {
    calls,
    runtime: {
      serverUrl: "http://127.0.0.1:4317",
      desktopBridgeSecret: "bridge-secret",
      windowCapability: "A".repeat(43),
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        return respond(url, init);
      }) as unknown as typeof globalThis.fetch,
    },
  };
}

describe("SSH target controls", () => {
  it("sends a window's request to the fixed local route with this window's authority, and hands back a refusal as an answer", async () => {
    const { calls, runtime: controls } = runtime(() =>
      Response.json({ status: "refused", reason: "worktree-dirty" }, { status: 409 }),
    );
    expect(
      await sendSshTargetOperation(controls, "remove-worktree", {
        worktreeId: "77777777-7777-4777-8777-777777777777",
      }),
    ).toEqual({ status: 409, body: { status: "refused", reason: "worktree-dirty" } });
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4317/api/desktop/ssh-targets/projects/worktrees/remove",
    );
    expect(calls[0]?.init?.headers).toEqual({
      "x-octant-desktop-secret": "bridge-secret",
      "x-octant-window-capability": "A".repeat(43),
      "content-type": "application/json",
    });
  });

  it("refuses an operation it does not name, a path in its place, and a body past its bound, sending nothing", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({}));
    for (const operation of ["../desktop/remote/pairing-tickets", "__proto__", "toString", 7]) {
      await expect(sendSshTargetOperation(controls, operation, {})).rejects.toBeInstanceOf(
        SshTargetControlFailure,
      );
    }
    await expect(
      sendSshTargetOperation(controls, "terminal", { data: "x".repeat(200 * 1_024) }),
    ).rejects.toBeInstanceOf(SshTargetControlFailure);
    expect(calls).toEqual([]);
  });
});
