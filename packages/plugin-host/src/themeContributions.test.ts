import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ExtensionPackageManifest,
  ExtensionPackageState,
  type ExtensionActivationState,
} from "@octant/contracts/extensions";
import { DEFAULT_DARK_TOKENS } from "@octant/theme";
import {
  contributedThemePresetId,
  effectiveContributedThemes,
  refusedThemeContribution,
} from "./themeContributions";

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

function themeComponent(tokens: Readonly<Record<string, string>> = DEFAULT_DARK_TOKENS) {
  return {
    id: "harbor-night",
    kind: "theme",
    displayName: "Harbor night",
    declaredCapabilities: [],
    theme: { supportedModes: ["dark"], tokens: { dark: tokens } },
  };
}

function packageState(input: {
  readonly effectiveState: unknown;
  readonly activation?: ExtensionActivationState;
  readonly component?: unknown;
}): ExtensionPackageState {
  return Schema.decodeUnknownSync(ExtensionPackageState)({
    extensionId: "10000000-0000-4000-8000-00000000c0de",
    packageId,
    slug: "harbor-night",
    displayName: "Harbor themes",
    stateVersion: 3,
    version: "1.0.0",
    digest: `sha256:${"c".repeat(64)}`,
    source: { kind: "local-folder", sourceRef: "harbor-night" },
    compatibility: { platforms: ["macos"], modes: ["chat", "work", "code"], providerFamilies: [] },
    activation: input.activation ?? on,
    components: [
      {
        component: input.component ?? themeComponent(),
        activation: input.activation ?? on,
        effectiveState: input.effectiveState,
      },
    ],
    diagnostics: [],
  });
}

describe("themes contributed by plugins", () => {
  it("lists a valid theme from an installed, trusted and enabled plugin under a host-assigned id", () => {
    const [preset, ...others] = effectiveContributedThemes([
      packageState({ effectiveState: { kind: "effective" } }),
    ]);
    expect(others).toEqual([]);
    expect(preset?.id).toBe(`plugin:${packageId}:harbor-night`);
    expect(String(contributedThemePresetId(packageId, "harbor-night"))).toBe(preset?.id);
    expect(preset?.displayName).toBe("Harbor night");
    expect(preset?.supportedModes).toEqual(["dark"]);
    expect(preset?.tokens.dark?.workspace).toBe(DEFAULT_DARK_TOKENS.workspace);
  });

  it("contributes no theme while the plugin is disabled, untrusted or not installed", () => {
    for (const reason of ["plugin-disabled", "untrusted", "not-installed", "component-disabled"]) {
      expect(
        effectiveContributedThemes([
          packageState({
            effectiveState: { kind: "blocked", reason },
            activation: { ...on, pluginDesired: false },
          }),
        ]),
      ).toEqual([]);
    }
  });

  it("never lists a theme that fails the semantic theme schema, even when its plugin is on", () => {
    const unreadable = {
      ...DEFAULT_DARK_TOKENS,
      "text-primary": DEFAULT_DARK_TOKENS.workspace ?? "",
    };
    expect(
      effectiveContributedThemes([
        packageState({
          effectiveState: { kind: "effective" },
          component: themeComponent(unreadable),
        }),
      ]),
    ).toEqual([]);
  });

  it("refuses a package whose theme misses a role or fails contrast, naming the reason", () => {
    const manifest = (tokens: Readonly<Record<string, string>>) =>
      Schema.decodeUnknownSync(ExtensionPackageManifest)({
        manifestVersion: 1,
        extensionId: "10000000-0000-4000-8000-00000000c0de",
        packageId,
        slug: "harbor-night",
        displayName: "Harbor themes",
        version: "1.0.0",
        digest: `sha256:${"c".repeat(64)}`,
        source: { kind: "local-folder", sourceRef: "harbor-night" },
        provenance: { reviewed: false },
        license: { kind: "unreported" },
        compatibility: {
          platforms: ["macos"],
          modes: ["chat", "work", "code"],
          providerFamilies: [],
        },
        declaredCapabilities: [],
        components: [themeComponent(tokens)],
      });

    expect(refusedThemeContribution(manifest(DEFAULT_DARK_TOKENS))).toBeUndefined();

    const { workspace: _workspace, ...missingWorkspace } = DEFAULT_DARK_TOKENS;
    const missing = refusedThemeContribution(manifest(missingWorkspace));
    expect(missing?.componentId).toBe("harbor-night");
    expect(missing?.errors).toContain("preset.tokens.dark.workspace is required");

    const lowContrast = refusedThemeContribution(
      manifest({ ...DEFAULT_DARK_TOKENS, "text-primary": DEFAULT_DARK_TOKENS.workspace ?? "" }),
    );
    expect(lowContrast?.errors.some((error) => error.includes("contrast"))).toBe(true);
  });
});
