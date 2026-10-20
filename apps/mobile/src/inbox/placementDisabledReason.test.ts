import { describe, expect, it } from "vitest";
import { presentPlacementDisabledReason } from "./placementDisabledReason";

describe("placement disabled reason", () => {
  const base = {
    hostLabel: "Studio",
    health: "ready" as const,
    healthDetail: undefined,
    modelsFailed: false,
  };

  it("says nothing when the host is ready and its models loaded", () => {
    expect(presentPlacementDisabledReason(base)).toBeUndefined();
  });

  it("tells the person to refresh a stale host and when it last refreshed", () => {
    expect(
      presentPlacementDisabledReason({
        ...base,
        health: "stale",
        healthDetail: "Last host refresh was 5 minutes ago",
      }),
    ).toBe("Studio is stale — last refresh 5 minutes ago. Refresh the host to send.");
  });

  it("names an unavailable host, or falls back to a generic name", () => {
    expect(presentPlacementDisabledReason({ ...base, health: "unavailable" })).toBe(
      "Studio is unavailable.",
    );
    expect(
      presentPlacementDisabledReason({ ...base, hostLabel: undefined, health: "unavailable" }),
    ).toBe("This host is unavailable.");
  });

  it("reports a model list that failed to load", () => {
    expect(presentPlacementDisabledReason({ ...base, modelsFailed: true })).toBe(
      "Couldn't load models from Studio.",
    );
  });
});
