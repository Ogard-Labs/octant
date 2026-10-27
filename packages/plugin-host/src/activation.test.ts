import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ExtensionPackageState, type ExtensionActivationState } from "@octant/contracts/extensions";
import {
  isExtensionComponentHostConfined,
  isExtensionComponentModeSafe,
  resolveExtensionActivation,
  resolveOutsideDriverActivation,
} from "./activation";

const effective: ExtensionActivationState = {
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

describe("effective extension activation", () => {
  it.each([
    ["chat", "skill-instructions", ["instructions"], true],
    ["chat", "app", ["apps"], false],
    ["chat", "mcp-tool", ["mcp", "shell"], false],
    ["work", "app", ["apps"], true],
    ["work", "hook", ["hooks"], false],
    ["work", "mcp-tool", ["mcp", "shell"], false],
    ["code", "hook", ["hooks", "shell"], true],
    ["code", "apple-development-adapter", ["apple-development"], true],
    ["code", "board", [], true],
    ["work", "board", [], false],
    ["chat", "integration", ["network", "credentials"], false],
    ["work", "integration", ["network", "credentials"], false],
    ["code", "integration", ["network", "credentials"], true],
    ["chat", "appearance-pack", [], true],
    ["work", "appearance-pack", [], true],
    ["code", "appearance-pack", [], true],
    ["chat", "preview-viewer", [], true],
    ["work", "preview-viewer", [], true],
    ["code", "preview-viewer", [], true],
    ["chat", "ui-surface", [], true],
    ["work", "ui-surface", [], true],
    ["code", "ui-surface", [], true],
    ["chat", "provider-driver", [], true],
    ["work", "provider-driver", [], true],
    ["code", "provider-driver", [], true],
    ["chat", "provider-driver", ["shell"], false],
    ["work", "provider-driver", ["shell"], false],
    ["code", "provider-driver", ["shell"], true],
    ["chat", "desktop-provider", ["computer-use"], false],
    ["work", "desktop-provider", ["computer-use"], true],
    ["code", "desktop-provider", ["computer-use"], true],
    ["chat", "language-server", [], false],
    ["work", "language-server", [], false],
    ["code", "language-server", [], true],
    ["chat", "debug-adapter", [], false],
    ["work", "debug-adapter", [], false],
    ["code", "debug-adapter", ["filesystem", "shell", "network"], true],
  ] as const)(
    "maps %s %s mode safety from component kind and capabilities",
    (mode, kind, declaredCapabilities, expected) => {
      expect(
        isExtensionComponentModeSafe(mode, {
          id: "component" as never,
          kind,
          displayName: "Component",
          declaredCapabilities,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ["darwin", "provider-driver", true],
    ["linux", "provider-driver", false],
    ["win32", "provider-driver", false],
    ["linux", "mcp-server", true],
  ] as const)(
    "lets a %s host run a stored %s component only where it is confined: %s",
    (platform, kind, expected) => {
      expect(
        isExtensionComponentHostConfined(platform, {
          id: "component" as never,
          kind,
          displayName: "Component",
          declaredCapabilities: [],
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ["host-prohibited", { hostAllowed: false }],
    ["mode-prohibited", { modeAllowed: false }],
    ["project-prohibited", { projectAllowed: false }],
    ["thread-prohibited", { threadAllowed: false }],
    ["stale-catalog-epoch", { catalogCurrent: false }],
    ["not-installed", { installed: false }],
    ["quarantined", { quarantined: true }],
    ["untrusted", { trusted: false }],
    ["plugin-disabled", { pluginDesired: false }],
    ["component-disabled", { componentDesired: false }],
    ["incompatible", { compatible: false }],
    ["draining", { draining: true }],
    ["broken", { broken: true }],
    ["unavailable", { unavailable: true }],
    ["interrupted", { interrupted: true }],
    ["waiting", { waiting: true }],
  ] as const)("returns the deterministic first block reason %s", (reason, patch) => {
    const result = resolveExtensionActivation({
      hostAllowed: true,
      modeAllowed: true,
      projectAllowed: true,
      threadAllowed: true,
      catalogCurrent: true,
      ...effective,
      ...patch,
    });
    expect(result).toEqual({ kind: "blocked", reason });
  });

  it("returns effective only when every independent dimension passes", () => {
    expect(
      resolveExtensionActivation({
        hostAllowed: true,
        modeAllowed: true,
        projectAllowed: true,
        threadAllowed: true,
        catalogCurrent: true,
        ...effective,
      }),
    ).toEqual({ kind: "effective" });
  });

  it("never lets a later pass override an earlier prohibition", () => {
    expect(
      resolveExtensionActivation({
        hostAllowed: false,
        modeAllowed: true,
        projectAllowed: true,
        threadAllowed: true,
        catalogCurrent: true,
        ...effective,
        waiting: true,
      }),
    ).toEqual({ kind: "blocked", reason: "host-prohibited" });
  });

  it("exhaustively selects the first blocked dimension for every truth-table row", () => {
    const dimensions = [
      ["host-prohibited", "hostAllowed", true, false],
      ["mode-prohibited", "modeAllowed", true, false],
      ["project-prohibited", "projectAllowed", true, false],
      ["thread-prohibited", "threadAllowed", true, false],
      ["stale-catalog-epoch", "catalogCurrent", true, false],
      ["not-installed", "installed", true, false],
      ["quarantined", "quarantined", false, true],
      ["untrusted", "trusted", true, false],
      ["plugin-disabled", "pluginDesired", true, false],
      ["component-disabled", "componentDesired", true, false],
      ["incompatible", "compatible", true, false],
      ["draining", "draining", false, true],
      ["broken", "broken", false, true],
      ["unavailable", "unavailable", false, true],
      ["interrupted", "interrupted", false, true],
      ["waiting", "waiting", false, true],
    ] as const;

    const mismatches: Array<{
      readonly row: number;
      readonly expected: unknown;
      readonly actual: unknown;
    }> = [];
    for (let row = 0; row < 2 ** dimensions.length; row += 1) {
      const state = {
        hostAllowed: true,
        modeAllowed: true,
        projectAllowed: true,
        threadAllowed: true,
        catalogCurrent: true,
        ...effective,
      };
      let expected:
        | { readonly kind: "effective" }
        | {
            readonly kind: "blocked";
            readonly reason: (typeof dimensions)[number][0];
          } = { kind: "effective" };
      for (const [index, [reason, key, pass, blocked]] of dimensions.entries()) {
        const isBlocked = (row & (1 << index)) !== 0;
        Object.assign(state, { [key]: isBlocked ? blocked : pass });
        if (isBlocked && expected.kind === "effective") {
          expected = { kind: "blocked", reason };
        }
      }
      const actual = resolveExtensionActivation(state);
      if (
        actual.kind !== expected.kind ||
        (actual.kind === "blocked" &&
          expected.kind === "blocked" &&
          actual.reason !== expected.reason)
      ) {
        mismatches.push({ row, expected, actual });
      }
    }
    expect(mismatches).toEqual([]);
  }, 30_000);
});

describe("outside driver activation for a provider instance", () => {
  const driver = {
    extensionId: "00000000-0000-4000-8000-000000000911",
    packageId: "00000000-0000-4000-8000-000000000912",
    componentId: "driver",
    version: "0.1.0",
    digest: `sha256:${"e".repeat(64)}`,
  } as const;
  const packageState = (
    activation: Partial<ExtensionActivationState> = {},
    overrides: Record<string, unknown> = {},
  ) =>
    Schema.decodeUnknownSync(ExtensionPackageState)({
      extensionId: driver.extensionId,
      packageId: driver.packageId,
      slug: "loopback-chat",
      displayName: "Loopback chat",
      stateVersion: 4,
      version: driver.version,
      digest: driver.digest,
      source: { kind: "local-folder", sourceRef: "folder-1" },
      compatibility: {
        platforms: ["macos"],
        modes: ["chat", "work", "code"],
        providerFamilies: [],
      },
      activation: { ...effective, ...activation },
      components: [
        {
          component: {
            id: "driver",
            kind: "provider-driver",
            displayName: "Loopback chat",
            declaredCapabilities: [],
            entryPoint: "dist/driver.mjs",
          },
          activation: { ...effective, ...activation },
          effectiveState: { kind: "effective" },
        },
      ],
      diagnostics: [],
      ...overrides,
    });
  const resolve = (
    state: ExtensionPackageState | undefined,
    options: { readonly platform?: string; readonly compatible?: boolean } = {},
  ) =>
    resolveOutsideDriverActivation({
      platform: options.platform ?? "darwin",
      packageState: state,
      compatible: options.compatible ?? true,
      driver,
    });

  it("admits the exact package a person trusted and switched on, on a host that confines it", () => {
    expect(resolve(packageState())).toEqual({ kind: "effective" });
  });

  it("is host-prohibited off macOS before anything about the package is read", () => {
    expect(resolve(packageState(), { platform: "linux" })).toEqual({
      kind: "blocked",
      reason: "host-prohibited",
    });
    expect(resolve(undefined, { platform: "win32" })).toEqual({
      kind: "blocked",
      reason: "host-prohibited",
    });
  });

  it("is superseded when the package selects any other version or digest", () => {
    expect(resolve(packageState({}, { digest: `sha256:${"f".repeat(64)}` }))).toEqual({
      kind: "blocked",
      reason: "superseded",
    });
    expect(resolve(packageState({}, { version: "0.2.0" }))).toEqual({
      kind: "blocked",
      reason: "superseded",
    });
  });

  it("follows the ladder for quarantine, trust, switches, and compatibility", () => {
    expect(resolve(undefined)).toEqual({ kind: "blocked", reason: "not-installed" });
    expect(resolve(packageState({ installed: false }))).toEqual({
      kind: "blocked",
      reason: "not-installed",
    });
    expect(resolve(packageState({ quarantined: true }))).toEqual({
      kind: "blocked",
      reason: "quarantined",
    });
    expect(resolve(packageState({ trusted: false }))).toEqual({
      kind: "blocked",
      reason: "untrusted",
    });
    expect(resolve(packageState({ pluginDesired: false }))).toEqual({
      kind: "blocked",
      reason: "plugin-disabled",
    });
    expect(resolve(packageState({ componentDesired: false }))).toEqual({
      kind: "blocked",
      reason: "component-disabled",
    });
    expect(resolve(packageState(), { compatible: false })).toEqual({
      kind: "blocked",
      reason: "incompatible",
    });
  });
});
