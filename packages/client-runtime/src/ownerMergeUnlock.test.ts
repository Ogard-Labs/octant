import { describe, expect, it, vi } from "vitest";
import { ownerMergeUnlockCopy, sendWithOwnerUnlock } from "./ownerMergeUnlock";

const PATH = "/api/code/project-pull-requests/merge";
const BODY = '{"number":12}';
const HOST = "11111111-1111-4111-8111-111111111111";
const merged = { status: "merged" as const };
const asked = (reason: string, hostMemberId: string | undefined = HOST) => ({
  status: "owner-unlock-required" as const,
  reason,
  ...(hostMemberId === undefined ? {} : { hostMemberId }),
});

describe("a paired client's merge on a host that may ask for an owner unlock", () => {
  it("sends once and never asks the person when the host merges without one", async () => {
    const send = vi.fn(async () => merged);
    const unlock = vi.fn();

    expect(await sendWithOwnerUnlock({ path: PATH, body: BODY, send, unlock })).toEqual(merged);
    expect(send).toHaveBeenCalledTimes(1);
    expect(unlock).not.toHaveBeenCalled();
  });

  it("does not ask the person again when the host refused an unlock or has no owner list", async () => {
    for (const answer of [asked("expired"), asked("no-owner-list", undefined)]) {
      const send = vi.fn(async () => answer);
      const unlock = vi.fn();

      expect(await sendWithOwnerUnlock({ path: PATH, body: BODY, send, unlock })).toEqual(answer);
      expect(send).toHaveBeenCalledTimes(1);
      expect(unlock).not.toHaveBeenCalled();
    }
  });

  it("reports the owner route's refusal of the challenge in plain words, and merges nothing", async () => {
    const send = vi.fn(async () => asked("missing"));

    const outcome = await sendWithOwnerUnlock({
      path: PATH,
      body: BODY,
      send,
      unlock: async () => ({ status: "refused", kind: "owners-not-honored" }),
    });

    expect(outcome).toEqual({
      status: "owner-unlock-not-given",
      reason: "refused",
      kind: "owners-not-honored",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ownerMergeUnlockCopy(outcome as never)).toBe(
      "This computer does not let owner devices act. Its person can change that. Nothing merged.",
    );
  });
});
