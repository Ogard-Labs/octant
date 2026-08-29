import { describe, expect, it, vi } from "vitest";
import { decodeHostId, LOCAL_HOST_ID, type HostIdentity } from "@octant/contracts/host";
import {
  assertCreateDestination,
  assertCreateDestinationFromHosts,
  createDestinationRefusalMessage,
} from "./assertCreateDestination";

const LOCAL = LOCAL_HOST_ID;
const LAPTOP = decodeHostId("22222222-2222-4222-8222-222222222222");

function host(
  hostId: HostIdentity["hostId"],
  health: HostIdentity["health"],
  displayName: string,
): HostIdentity {
  return { hostId, displayName, health, capabilities: ["chat", "work", "code"] };
}

describe("assertCreateDestination", () => {
  it("accepts a healthy destination", () => {
    expect(
      assertCreateDestination({
        hosts: [host(LOCAL, "healthy", "This Mac")],
        requestedHostId: LOCAL,
        action: "create-work-thread",
      }),
    ).toEqual({ kind: "ok", hostId: LOCAL });
  });

  it("refuses a stale destination without queuing", () => {
    const decision = assertCreateDestination({
      hosts: [host(LAPTOP, "stale", "Laptop")],
      requestedHostId: LAPTOP,
      action: "create-work-thread",
    });
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") return;
    expect(decision.reason).toMatch(/not connected|Reconnect/i);
  });

  it("refuses when lifecycle mutationDecision denies a host that looks healthy", () => {
    const mutationDecision = vi.fn(() => ({
      allowed: false as const,
      queued: false as const,
      reason:
        "Host local is stale (read-only). Reconnect before create-project; mutations are not queued.",
    }));
    const decision = assertCreateDestinationFromHosts({
      hosts: [host(LOCAL, "healthy", "This Mac")],
      createHostId: LOCAL,
      action: "create-project",
      mutationDecision,
    });
    expect(decision).toEqual({
      kind: "refused",
      reason:
        "Host local is stale (read-only). Reconnect before create-project; mutations are not queued.",
    });
    expect(mutationDecision).toHaveBeenCalledWith(LOCAL, "create-project");
  });

  it("maps every rejection reason to user-facing copy", () => {
    expect(createDestinationRefusalMessage("unknown-host")).toMatch(/not registered/i);
    expect(createDestinationRefusalMessage("host-unavailable")).toMatch(/Reconnect/i);
    expect(createDestinationRefusalMessage("host-unauthorized")).toMatch(/unauthorized/i);
    expect(createDestinationRefusalMessage("host-incompatible")).toMatch(/cannot run/i);
    expect(createDestinationRefusalMessage("project-host-mismatch")).toMatch(/fixed/i);
  });
});
