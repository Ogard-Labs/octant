import { describe, expect, it } from "vitest";
import { buildMobileThreadDeepLink } from "../notifications/deepLinks";
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
});
