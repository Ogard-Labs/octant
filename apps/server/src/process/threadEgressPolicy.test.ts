import { describe, expect, it } from "vitest";
import {
  clampChildThreadEgressPolicy,
  materializeOsNetworkEgress,
  resolveDefaultThreadEgressPolicy,
  type ThreadEgressPolicy,
} from "./threadEgressPolicy";

describe("thread egress policy", () => {
  it("defaults Work and Plan to none", () => {
    expect(
      resolveDefaultThreadEgressPolicy({
        mode: "work",
        executionPolicy: "approval-gated",
      }),
    ).toBe("none");
    expect(
      resolveDefaultThreadEgressPolicy({
        mode: "code",
        executionPolicy: "plan",
      }),
    ).toBe("none");
    expect(
      resolveDefaultThreadEgressPolicy({
        mode: "chat",
        executionPolicy: "approval-gated",
      }),
    ).toBe("none");
  });

  it("defaults Code approval-gated to provider-endpoints-only", () => {
    expect(
      resolveDefaultThreadEgressPolicy({
        mode: "code",
        executionPolicy: "approval-gated",
      }),
    ).toBe("provider-endpoints-only");
  });

  it("resolves Full access and explicit network approval to unrestricted", () => {
    expect(
      resolveDefaultThreadEgressPolicy({
        mode: "code",
        executionPolicy: "full-access",
      }),
    ).toBe("unrestricted");
    expect(
      resolveDefaultThreadEgressPolicy({
        mode: "work",
        executionPolicy: "approval-gated",
        explicitNetworkApproval: true,
      }),
    ).toBe("unrestricted");
  });

  it("materializes only two OS Seatbelt levels (none/allow)", () => {
    expect(materializeOsNetworkEgress("none")).toBe("none");
    expect(materializeOsNetworkEgress("provider-endpoints-only")).toBe("allow");
    expect(materializeOsNetworkEgress("unrestricted")).toBe("allow");
  });

  it("documents that provider-endpoints-only host allowlists are broker-enforced", () => {
    // Seatbelt cannot express host allowlists in V1. OS level is `allow`;
    // Octant-owned brokered tools enforce the finer host allowlist.
    expect(materializeOsNetworkEgress("provider-endpoints-only")).toBe("allow");
  });

  it("clamps child sandboxes to equal-or-narrower egress", () => {
    expect(
      clampChildThreadEgressPolicy({
        parent: "unrestricted",
        childNetworkAuthority: false,
      }),
    ).toBe("none");
    expect(
      clampChildThreadEgressPolicy({
        parent: "unrestricted",
        childNetworkAuthority: true,
        requested: "provider-endpoints-only",
      }),
    ).toBe("provider-endpoints-only");
    expect(
      clampChildThreadEgressPolicy({
        parent: "none",
        childNetworkAuthority: true,
        requested: "unrestricted",
      }),
    ).toBe("none");
    expect(
      clampChildThreadEgressPolicy({
        parent: "provider-endpoints-only",
        childNetworkAuthority: true,
        requested: "unrestricted",
      }),
    ).toBe("provider-endpoints-only");
  });

  it("never widens a child above its parent policy", () => {
    const parents: ThreadEgressPolicy[] = ["none", "provider-endpoints-only", "unrestricted"];
    for (const parent of parents) {
      for (const requested of parents) {
        const clamped = clampChildThreadEgressPolicy({
          parent,
          childNetworkAuthority: true,
          requested,
        });
        const rank = { none: 0, "provider-endpoints-only": 1, unrestricted: 2 } as const;
        expect(rank[clamped]).toBeLessThanOrEqual(rank[parent]);
        expect(rank[clamped]).toBeLessThanOrEqual(rank[requested]);
      }
    }
  });
});
