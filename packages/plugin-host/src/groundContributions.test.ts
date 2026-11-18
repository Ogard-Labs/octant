import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ExtensionPackageState, type ExtensionActivationState } from "@octant/contracts/extensions";
import { contributedGroundId, groundContributions } from "./groundContributions";

const packageId = "20000000-0000-4000-8000-00000000c0de";

const on: ExtensionActivationState = {
  installed: true,
  trusted: true,
  pluginDesired: true,
  componentDesired: true,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};

const groundComponent = {
  id: "dots",
  kind: "ground",
  displayName: "Night dots",
  declaredCapabilities: [],
  ground: { characterSet: "·•●", characterDensity: 60 },
};

function packageState(effectiveState: unknown): ExtensionPackageState {
  return Schema.decodeUnknownSync(ExtensionPackageState)({
    extensionId: "10000000-0000-4000-8000-00000000c0de",
    packageId,
    slug: "night-dots",
    displayName: "Night pack",
    stateVersion: 3,
    version: "1.0.0",
    digest: `sha256:${"c".repeat(64)}`,
    source: { kind: "local-folder", sourceRef: "night-dots" },
    compatibility: { platforms: ["macos"], modes: ["chat", "work", "code"], providerFamilies: [] },
    activation: on,
    components: [{ component: groundComponent, activation: on, effectiveState }],
    diagnostics: [],
  });
}

describe("grounds contributed by plugins", () => {
  it("lists a ground from an installed, trusted and enabled plugin under a host-assigned id", () => {
    const [ground, ...others] = groundContributions([packageState({ kind: "effective" })]);
    expect(others).toEqual([]);
    expect(ground?.id).toBe(`plugin:${packageId}:dots`);
    expect(ground?.id).toBe(contributedGroundId(packageId, "dots"));
    expect(ground?.displayName).toBe("Night dots");
    expect(ground?.pluginName).toBe("Night pack");
    expect(ground?.ground).toEqual({ characterSet: "·•●", characterDensity: 60 });
  });

  it("lists no ground while the plugin is disabled, untrusted or not installed", () => {
    for (const reason of ["plugin-disabled", "untrusted", "not-installed", "component-disabled"]) {
      expect(groundContributions([packageState({ kind: "blocked", reason })])).toEqual([]);
    }
  });
});
