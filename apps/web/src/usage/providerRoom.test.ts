import type { ProviderUsageLimitsEntry } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { providerRoomByInstance } from "./providerRoom";

const NOW = Date.parse("2026-10-31T12:00:00Z");

function entry(
  id: string,
  windows: ReadonlyArray<{
    window: string;
    status: string;
    utilization?: number;
    resetsAt?: string;
  }>,
): ProviderUsageLimitsEntry {
  return {
    providerInstanceId: id,
    status: "available",
    source: "provider-runtime",
    observedAt: "2026-10-31T11:59:00Z",
    limits: { rateLimitWindows: windows },
  } as unknown as ProviderUsageLimitsEntry;
}

describe("providerRoomByInstance", () => {
  it("calls an account limited when a window is exhausted and reports the latest reset", () => {
    const rooms = providerRoomByInstance(
      [
        entry("a", [
          {
            window: "five_hour",
            status: "exhausted",
            utilization: 1,
            resetsAt: "2026-10-31T14:00:00Z",
          },
          {
            window: "seven_day",
            status: "exhausted",
            utilization: 1,
            resetsAt: "2026-11-02T12:00:00Z",
          },
        ]),
      ],
      NOW,
    );
    expect(rooms.get("a")).toEqual({ standing: "limited", resetsAt: "2026-11-02T12:00:00Z" });
  });

  it("calls an account near its limit from the share used and keeps accounts with room apart", () => {
    const rooms = providerRoomByInstance(
      [
        entry("near", [
          {
            window: "five_hour",
            status: "allowed",
            utilization: 0.9,
            resetsAt: "2026-10-31T14:00:00Z",
          },
        ]),
        entry("room", [{ window: "five_hour", status: "allowed", utilization: 0.2 }]),
      ],
      NOW,
    );
    expect(rooms.get("near")).toEqual({ standing: "near", resetsAt: "2026-10-31T14:00:00Z" });
    expect(rooms.get("room")).toEqual({ standing: "room" });
  });

  it("calls an account limited when a window is exhausted without a utilization figure", () => {
    const rooms = providerRoomByInstance(
      [
        entry("a", [
          { window: "five_hour", status: "allowed", utilization: 0.1 },
          { window: "seven_day", status: "exhausted", resetsAt: "2026-11-02T12:00:00Z" },
        ]),
      ],
      NOW,
    );
    expect(rooms.get("a")).toEqual({ standing: "limited", resetsAt: "2026-11-02T12:00:00Z" });
  });

  it("says nothing about an account whose window already reset", () => {
    const rooms = providerRoomByInstance(
      [
        entry("old", [
          {
            window: "five_hour",
            status: "exhausted",
            utilization: 1,
            resetsAt: "2026-10-31T10:00:00Z",
          },
        ]),
      ],
      NOW,
    );
    expect(rooms.has("old")).toBe(false);
  });
});
