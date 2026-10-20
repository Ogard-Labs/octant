import { describe, expect, it } from "vitest";
import { buildMobileThreadDeepLink } from "../notifications/deepLinks";
import {
  DEEP_LINK_HOST_NOT_PAIRED,
  deepLinkRefusal,
  inboxRowFromDeepLinkTarget,
  resolveDeepLinkToInboxRow,
} from "./deepLinkNavigation";

const hostId = "11111111-1111-4111-8111-111111111111";
const threadId = "00000000-0000-4000-8000-000000000001";

describe("deep link navigation", () => {
  it("builds a synthetic inbox row for cold-open links", () => {
    const url = buildMobileThreadDeepLink({ hostId, threadId, mode: "code" });
    expect(resolveDeepLinkToInboxRow(url)).toEqual({
      hostId,
      threadId,
      mode: "code",
      title: "Thread",
      status: "active",
      freshness: "1970-01-01T00:00:00.000Z",
    });
  });

  it("prefers a known inbox row when present", () => {
    const known = {
      hostId,
      threadId,
      mode: "chat" as const,
      title: "Known",
      status: "active",
      freshness: "2026-08-05T20:00:00.000Z",
    };
    expect(inboxRowFromDeepLinkTarget({ hostId, threadId, mode: "chat" }, [known])).toBe(known);
  });

  it("ignores malformed urls", () => {
    expect(resolveDeepLinkToInboxRow("https://example.com")).toBeUndefined();
  });

  it("refuses a link that names no mode instead of opening it as Chat", () => {
    expect(inboxRowFromDeepLinkTarget({ hostId, threadId })).toBeUndefined();
    expect(
      resolveDeepLinkToInboxRow(`octant://hosts/${hostId}/threads/${threadId}`),
    ).toBeUndefined();
  });

  it("does not take a known row of another mode for the linked thread", () => {
    const known = {
      hostId,
      threadId,
      mode: "work" as const,
      title: "Known",
      status: "active",
      freshness: "2026-08-05T20:00:00.000Z",
    };
    expect(inboxRowFromDeepLinkTarget({ hostId, threadId, mode: "code" }, [known])?.mode).toBe(
      "code",
    );
  });

  it("explains a link to a computer that is not paired on this phone", () => {
    expect(deepLinkRefusal({ hostId }, ["someone-else"])).toBe(DEEP_LINK_HOST_NOT_PAIRED);
    expect(deepLinkRefusal({ hostId }, [hostId])).toBeUndefined();
  });
});
