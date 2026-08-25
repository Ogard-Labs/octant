import { describe, expect, it } from "vitest";
import type { MobileInboxHostFailure } from "@octant/client-runtime";
import { summarizeMobileInboxFailures } from "./mobileInboxAvailability";

const failure = (hostId: string, message: string): MobileInboxHostFailure => ({
  hostId,
  category: "unavailable",
  message,
});

describe("mobile Inbox transport availability", () => {
  it("does not replace a host failure with an empty-inbox message", () => {
    expect(
      summarizeMobileInboxFailures({
        failures: [failure("studio", "Could not reach the host.")],
        hostLabels: new Map([["studio", "Studio Mac"]]),
      }),
    ).toBe("Studio Mac: Could not reach the host.");
  });

  it("keeps each unavailable host visible in a partial-availability summary", () => {
    expect(
      summarizeMobileInboxFailures({
        failures: [
          failure("studio", "Studio is offline."),
          failure("laptop", "Laptop rejected the session."),
        ],
        hostLabels: new Map([["studio", "Studio Mac"]]),
      }),
    ).toBe("Studio Mac: Studio is offline. laptop: Laptop rejected the session.");
  });

  it("returns no transport error for an empty successful result", () => {
    expect(summarizeMobileInboxFailures({ failures: [], hostLabels: new Map() })).toBeUndefined();
  });
});
