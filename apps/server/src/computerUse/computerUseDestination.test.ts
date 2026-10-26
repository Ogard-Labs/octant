import { decodeDesktopProviderId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  isComputerUseDestinationRefusal,
  refuseComputerUseDestination,
  reportComputerUseDestination,
} from "./computerUseDestination";

const leasable = [
  {
    providerId: decodeDesktopProviderId("host-local"),
    displayName: "Host-local desktop",
    locality: "host-local",
    billed: false,
  },
] as const;

describe("computer-use destination capability", () => {
  it("reports a macOS host screen as an available destination", () => {
    expect(reportComputerUseDestination({ platform: "darwin", hasScreen: true })).toEqual({
      status: "available",
      kind: "macos-host",
    });
  });

  it("reports no destination on a headless macOS host without a usable screen", () => {
    expect(reportComputerUseDestination({ platform: "darwin", hasScreen: false })).toEqual({
      status: "unavailable",
      kind: "no-destination",
    });
  });

  it("defaults to available on macOS when hasScreen is not provided", () => {
    expect(reportComputerUseDestination({ platform: "darwin" })).toEqual({
      status: "available",
      kind: "macos-host",
    });
  });

  it("reports no provider configured on a host without a computer-use destination", () => {
    expect(reportComputerUseDestination({ platform: "linux" })).toEqual({
      status: "unavailable",
      kind: "no-provider-configured",
    });
    expect(reportComputerUseDestination({ platform: "win32" })).toEqual({
      status: "unavailable",
      kind: "no-provider-configured",
    });
  });

  it("names the providers a headless host could lease a disposable desktop from", () => {
    expect(reportComputerUseDestination({ platform: "linux", leasable })).toEqual({
      status: "leasable",
      kind: "disposable-desktop",
      leasable,
    });
    expect(
      reportComputerUseDestination({ platform: "darwin", hasScreen: false, leasable }),
    ).toEqual({ status: "leasable", kind: "disposable-desktop", leasable });
    expect(reportComputerUseDestination({ platform: "darwin", hasScreen: true, leasable })).toEqual(
      {
        status: "available",
        kind: "macos-host",
        leasable,
      },
    );
    expect(reportComputerUseDestination({ platform: "linux", leasable: [] })).toEqual({
      status: "unavailable",
      kind: "no-provider-configured",
    });
  });

  it("refuses the Mac runtime on a host that can only lease a desktop", () => {
    expect(
      refuseComputerUseDestination({ status: "leasable", kind: "disposable-desktop", leasable }),
    ).toEqual({ status: "refused", kind: "unavailable", reason: "no-destination" });
  });

  it("refuses as a value rather than throwing when the destination is absent", () => {
    expect(
      refuseComputerUseDestination({ status: "unavailable", kind: "no-provider-configured" }),
    ).toEqual({
      status: "refused",
      kind: "unavailable",
      reason: "no-provider-configured",
    });
    expect(refuseComputerUseDestination({ status: "unavailable", kind: "no-destination" })).toEqual(
      {
        status: "refused",
        kind: "unavailable",
        reason: "no-destination",
      },
    );
    expect(
      refuseComputerUseDestination({ status: "available", kind: "macos-host" }),
    ).toBeUndefined();
    expect(
      isComputerUseDestinationRefusal({
        status: "refused",
        kind: "unavailable",
        reason: "no-provider-configured",
      }),
    ).toBe(true);
  });
});
