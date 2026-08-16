import { describe, expect, it } from "vitest";
import { buildMobileThreadDeepLink } from "../notifications/deepLinks";
import { inboxRowFromDeepLinkTarget, resolveDeepLinkToInboxRow } from "./deepLinkNavigation";

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
});
