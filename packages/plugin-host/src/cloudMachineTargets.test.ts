import { describe, expect, it } from "vitest";
import type { CloudMachineTarget } from "@octant/plugin-api";
import { offerCloudMachineTarget, offeredCloudMachineTargets } from "./cloudMachineTargets";

const unused = async (): Promise<never> => {
  throw new Error("a withheld target is never called");
};

const target: CloudMachineTarget = {
  kind: "cloud-machine-target",
  create: unused,
  describe: unused,
  suspend: unused,
  resume: unused,
  destroy: unused,
};

const ready = { installed: true, trusted: true, enabled: true };

describe("cloud machine targets", () => {
  it("offers a target only once it is installed, trusted and enabled", () => {
    expect(offerCloudMachineTarget(ready)).toEqual({ status: "offered" });
    expect(offerCloudMachineTarget({ ...ready, installed: false })).toEqual({
      status: "withheld",
      reason: "not-installed",
    });
    expect(offerCloudMachineTarget({ ...ready, trusted: false })).toEqual({
      status: "withheld",
      reason: "not-trusted",
    });
    expect(offerCloudMachineTarget({ ...ready, enabled: false })).toEqual({
      status: "withheld",
      reason: "disabled",
    });
  });

  it("lists no target from a disabled plugin", () => {
    expect(
      offeredCloudMachineTargets([
        {
          targetId: "example.machines/fake",
          displayName: "Fake",
          facts: { ...ready, enabled: false },
          target,
        },
      ]),
    ).toEqual([]);
  });

  it("withholds every target that shares an id rather than choosing one", () => {
    const offered = offeredCloudMachineTargets([
      { targetId: "b.plugin/one", displayName: "B", facts: ready, target },
      { targetId: "a.plugin/one", displayName: "A", facts: ready, target },
      { targetId: "a.plugin/one", displayName: "A again", facts: ready, target },
    ]);
    expect(offered.map((entry) => entry.targetId)).toEqual(["b.plugin/one"]);
  });

  it("refuses a target whose contribution is not a cloud machine target", () => {
    expect(
      offeredCloudMachineTargets([
        {
          targetId: "a.plugin/one",
          displayName: "A",
          facts: ready,
          target: { ...target, kind: "replica-store" as never },
        },
      ]),
    ).toEqual([]);
  });
});
