import { describe, expect, it } from "vitest";
import { buildMobileMovesDeepLink, buildMobileThreadDeepLink } from "../notifications/deepLinks";
import { DEEP_LINK_HOST_NOT_PAIRED, movesLinkOpening } from "./deepLinkNavigation";
import { captureMobileDeepLink, consumeMobileDeepLink } from "./mobileDeepLinkCaptureState";

describe("mobile deep-link capture", () => {
  it("retains a warm link until the unlocked navigator consumes it", () => {
    const url = buildMobileThreadDeepLink({
      hostId: "11111111-1111-4111-8111-111111111111",
      threadId: "00000000-0000-4000-8000-000000000001",
      mode: "code",
    });

    const captured = captureMobileDeepLink({}, url);

    expect(captured.pendingDeepLinkRow).toMatchObject({ mode: "code" });
    expect(consumeMobileDeepLink(captured)).toEqual({});
  });

  it("does not replace a pending link with an unrelated URL", () => {
    const state = captureMobileDeepLink(
      {},
      buildMobileThreadDeepLink({
        hostId: "11111111-1111-4111-8111-111111111111",
        threadId: "00000000-0000-4000-8000-000000000001",
      }),
    );

    expect(captureMobileDeepLink(state, "https://example.com")).toBe(state);
  });

  it("opens the Computers screen, where the moves waiting list is, when a held-move notification is tapped", () => {
    const hostId = "11111111-1111-4111-8111-111111111111";
    const waitingThread = captureMobileDeepLink(
      {},
      buildMobileThreadDeepLink({
        hostId,
        threadId: "00000000-0000-4000-8000-000000000001",
        mode: "chat",
      }),
    );

    // The notification the person tapped last wins.
    const captured = captureMobileDeepLink(waitingThread, buildMobileMovesDeepLink(hostId));

    expect(captured).toEqual({ pendingMovesLink: { hostId } });
    const link = captured.pendingMovesLink;
    if (link === undefined) throw new Error("The moves link was not kept.");
    expect(movesLinkOpening(link, [hostId])).toEqual({ route: "hosts", entryMode: "manage" });
    expect(movesLinkOpening(link, ["someone-else"])).toEqual({
      route: "hosts",
      entryMode: "manage",
      notice: DEEP_LINK_HOST_NOT_PAIRED,
    });
    expect(consumeMobileDeepLink(captured)).toEqual({});
  });
});
