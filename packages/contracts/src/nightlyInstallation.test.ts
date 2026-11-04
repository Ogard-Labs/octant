import { describe, expect, it } from "vitest";
import { decodeNightlyInstallationState } from "./nightlyInstallation";

describe("Nightly installation state", () => {
  it("requires a recognized installed version before exposing installed application actions", () => {
    const state = {
      status: "ready",
      productName: "Octant Nightly",
      application: { kind: "installed", version: "0.1.0-preview.20261104.1", running: false },
    };
    expect(decodeNightlyInstallationState(state)).toEqual(state);
    expect(() =>
      decodeNightlyInstallationState({
        ...state,
        application: { kind: "installed", running: false },
      }),
    ).toThrow();
    expect(() =>
      decodeNightlyInstallationState({
        ...state,
        application: { ...state.application, path: "/Applications/Other.app" },
      }),
    ).toThrow();
    expect(() => decodeNightlyInstallationState({ ...state, productName: "Other" })).toThrow();
  });
});
