import { describe, expect, it } from "vitest";
import { callOfferedReplicaStore, offerReplicaStore } from "./replicaStoreActivation";

describe("replica store activation", () => {
  it("offers a store that is installed and enabled", () => {
    let calls = 0;
    const result = callOfferedReplicaStore({ installed: true, enabled: true }, () => {
      calls += 1;
      return "called";
    });
    expect(offerReplicaStore({ installed: true, enabled: true })).toEqual({ status: "offered" });
    expect(result).toBe("called");
    expect(calls).toBe(1);
  });

  it("does not offer or call a store that is not installed", () => {
    let calls = 0;
    const result = callOfferedReplicaStore({ installed: false, enabled: true }, () => {
      calls += 1;
      return "called";
    });
    expect(result).toEqual({ status: "withheld", reason: "not-installed" });
    expect(calls).toBe(0);
  });

  it("does not offer or call a store that is disabled", () => {
    let calls = 0;
    const result = callOfferedReplicaStore({ installed: true, enabled: false }, () => {
      calls += 1;
      return "called";
    });
    expect(result).toEqual({ status: "withheld", reason: "disabled" });
    expect(calls).toBe(0);
  });

  it("withholds an uninstalled store before it considers enablement", () => {
    expect(offerReplicaStore({ installed: false, enabled: false })).toEqual({
      status: "withheld",
      reason: "not-installed",
    });
  });
});
