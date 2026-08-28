import { describe, expect, it } from "vitest";
import type { ExtensionActivationState } from "@octant/contracts/extensions";
import { isExtensionComponentModeSafe, resolveExtensionActivation } from "./activation";

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
