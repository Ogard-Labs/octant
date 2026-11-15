import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadMobileCodeConversation,
  type MobileCodeConversation,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { loadCodeConversationPage } from "./codeConversationPage";

vi.mock("@octant/client-runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@octant/client-runtime")>("@octant/client-runtime");
  return { ...actual, loadMobileCodeConversation: vi.fn() };
});

const load = vi.mocked(loadMobileCodeConversation);
const transport = { hostId: "host-1" } as MobileRemoteTransport;

function page(
  operationIds: ReadonlyArray<string>,
  bounds: { readonly hasEarlier: boolean; readonly hasLater: boolean },
): MobileCodeConversation {
  return {
    turns: operationIds.map((operationId) => ({
      operationId,
      status: "completed",
      prompt: operationId,
      assistant: [],
      routines: [],
      updatedAt: "2026-11-15T10:00:00.000Z",
    })),
    ...bounds,
  };
}

describe("the Code page the phone shows", () => {
  beforeEach(() => load.mockReset());

  it("opens on the newest page when the search hit is on it", async () => {
    load.mockResolvedValueOnce(page(["old", "hit", "new"], { hasEarlier: true, hasLater: false }));

    const shown = await loadCodeConversationPage(transport, "thread", undefined, "hit");

    expect(load).toHaveBeenCalledOnce();
    expect(shown.anchoredAt).toBeUndefined();
  });

  it("opens on the page ending at a search hit older than the newest page, anchored there", async () => {
    load
      .mockResolvedValueOnce(page(["new"], { hasEarlier: true, hasLater: false }))
      .mockResolvedValueOnce(page(["older", "hit"], { hasEarlier: true, hasLater: true }));

    const shown = await loadCodeConversationPage(transport, "thread", undefined, "hit");

    expect(load).toHaveBeenLastCalledWith(transport, "thread", { through: "hit" });
    expect(shown.anchoredAt).toBe("hit");
    expect(shown.loaded.turns.map((turn) => turn.operationId)).toEqual(["older", "hit"]);
  });

  it("stays on the anchored page across refreshes and lets go once it reaches the newest", async () => {
    load.mockResolvedValueOnce(page(["older", "hit"], { hasEarlier: true, hasLater: true }));
    expect((await loadCodeConversationPage(transport, "thread", "hit", undefined)).anchoredAt).toBe(
      "hit",
    );

    // The host no longer holds the turn and answered the newest page instead.
    load.mockResolvedValueOnce(page(["new"], { hasEarlier: true, hasLater: false }));
    expect(
      (await loadCodeConversationPage(transport, "thread", "hit", undefined)).anchoredAt,
    ).toBeUndefined();
  });
});
