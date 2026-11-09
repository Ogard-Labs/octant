import { describe, expect, it } from "vitest";
import {
  buildMobileMovesDeepLink,
  buildMobileThreadDeepLink,
  parseMobileMovesDeepLink,
  parseMobileThreadDeepLink,
} from "./deepLinks";

describe("mobile deep links", () => {
  it("round-trips host/thread and mode-qualified links", () => {
    const plain = {
      hostId: "11111111-1111-4111-8111-111111111111",
      threadId: "00000000-0000-4000-8000-000000000001",
    };
    expect(parseMobileThreadDeepLink(buildMobileThreadDeepLink(plain))).toEqual(plain);
    const withMode = { ...plain, mode: "code" as const };
    expect(parseMobileThreadDeepLink(buildMobileThreadDeepLink(withMode))).toEqual(withMode);
  });

  it("rejects foreign schemes and malformed paths", () => {
    expect(parseMobileThreadDeepLink("https://example.com/x")).toBeUndefined();
    expect(parseMobileThreadDeepLink("octant://hosts/only")).toBeUndefined();
  });

  it("round-trips the link a held-move notification opens, and keeps it apart from thread links", () => {
    const hostId = "11111111-1111-4111-8111-111111111111";
    expect(parseMobileMovesDeepLink(buildMobileMovesDeepLink(hostId))).toEqual({ hostId });
    expect(parseMobileMovesDeepLink(`octant:///hosts/${hostId}/moves`)).toEqual({ hostId });
    expect(parseMobileThreadDeepLink(buildMobileMovesDeepLink(hostId))).toBeUndefined();
    expect(parseMobileMovesDeepLink(`octant://hosts/${hostId}/moves/extra`)).toBeUndefined();
    expect(parseMobileMovesDeepLink(`https://hosts/${hostId}/moves`)).toBeUndefined();
    expect(
      parseMobileMovesDeepLink(`octant://hosts/${hostId}/threads/chat/thread-1`),
    ).toBeUndefined();
  });
});
