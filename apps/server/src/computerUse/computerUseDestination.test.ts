import { describe, expect, it } from "vitest";
import {
  isComputerUseDestinationRefusal,
  refuseComputerUseDestination,
  reportComputerUseDestination,
} from "./computerUseDestination";

describe("computer-use destination capability", () => {
  it("reports a macOS host screen as an available destination", () => {
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

  it("reports no destination when a provider is configured but no screen exists", () => {
    expect(reportComputerUseDestination({ platform: "linux", providerConfigured: true })).toEqual({
      status: "unavailable",
      kind: "no-destination",
    });
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
