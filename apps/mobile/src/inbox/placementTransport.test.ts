import { describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { selectMobilePlacementTransport } from "./placementTransport";

function transport(hostId: string): MobileRemoteTransport {
  return {
    hostId,
    authenticatedFetch: vi.fn(),
  };
}

describe("selectMobilePlacementTransport", () => {
  it("does not fall back to another host when the selected host is unavailable", () => {
    const fallback = transport("healthy-host");

    expect(
      selectMobilePlacementTransport({
        placementHostId: "unavailable-host",
        transports: [fallback],
        transportForHost: () => undefined,
      }),
    ).toBeUndefined();
  });

  it("uses the first host only when no placement host was selected", () => {
    const first = transport("first-host");

    expect(
      selectMobilePlacementTransport({
        placementHostId: undefined,
        transports: [first],
        transportForHost: () => undefined,
      }),
    ).toBe(first);
  });
});
