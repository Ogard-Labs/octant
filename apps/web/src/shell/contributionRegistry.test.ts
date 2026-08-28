import { describe, expect, it } from "vitest";
import { FIRST_PARTY_PLUGIN_CATALOG } from "./firstPartyPluginCatalog";
import {
  isAppearancePresetAvailable,
  isPreviewViewerAvailable,
  isSettingsSectionAvailable,
  resolveAppearancePresetContributions,
  resolveBoardViewContributions,
  resolvePreviewViewerContributions,
  resolveSettingsSectionContributions,
  resolveSidebarContributions,
  resolveThreadPaneContributions,
  resolveWorkspaceTabContributions,
  type FirstPartyPluginComponentId,
} from "./contributionRegistry";

function effectiveMap(
  entries: Partial<Record<FirstPartyPluginComponentId, boolean>>,
): ReadonlyMap<FirstPartyPluginComponentId, boolean> {
  return new Map(Object.entries(entries) as Array<[FirstPartyPluginComponentId, boolean]>);
}

describe("first-party plugin catalog", () => {
  it("decodes every bundled first-party manifest on the current version", () => {
    expect(FIRST_PARTY_PLUGIN_CATALOG.map((plugin) => plugin.slug)).toEqual([
      "board",
      "github",
      "linear",
      "appearance",
      "preview-viewers",
    ]);
    expect(FIRST_PARTY_PLUGIN_CATALOG.every((plugin) => plugin.manifestVersion === 1)).toBe(true);
  });
});

describe("resolveSidebarContributions", () => {
  it("includes thread-board for work and code when the board plugin is effective", () => {
    const effective = effectiveMap({ board: true });
    expect(resolveSidebarContributions("work", effective).has("thread-board")).toBe(true);
    expect(resolveSidebarContributions("code", effective).has("thread-board")).toBe(true);
    expect(resolveSidebarContributions("chat", effective).has("thread-board")).toBe(false);
  });

  it("omits thread-board when the board plugin is not effective", () => {
    const effective = effectiveMap({ board: false });
    expect(resolveSidebarContributions("code", effective).has("thread-board")).toBe(false);
  });

  it("includes pull-requests only in code mode when github is effective", () => {
    const effective = effectiveMap({ "github-integration": true });
    expect(resolveSidebarContributions("code", effective).has("pull-requests")).toBe(true);
    expect(resolveSidebarContributions("work", effective).has("pull-requests")).toBe(false);
  });

  it("treats an unlisted component as not effective", () => {
    expect(resolveSidebarContributions("code", effectiveMap({})).size).toBe(0);
  });
});

describe("resolveSettingsSectionContributions", () => {
  it("includes github when effective", () => {
    expect(
      resolveSettingsSectionContributions(effectiveMap({ "github-integration": true })).has(
        "github",
      ),
    ).toBe(true);
  });

  it("omits github when not effective", () => {
    expect(
      resolveSettingsSectionContributions(effectiveMap({ "github-integration": false })).has(
        "github",
      ),
    ).toBe(false);
  });

  it("omits linear when the bundled-off plugin is not effective", () => {
    expect(
      resolveSettingsSectionContributions(effectiveMap({ "linear-integration": false })).has(
        "linear",
      ),
    ).toBe(false);
    expect(isSettingsSectionAvailable("linear", effectiveMap({}))).toBe(false);
  });

  it("includes linear only when the plugin is effective", () => {
    expect(
      resolveSettingsSectionContributions(effectiveMap({ "linear-integration": true })).has(
        "linear",
      ),
    ).toBe(true);
  });

  it("keeps host-owned settings sections visible when no plugin contributes them", () => {
    expect(isSettingsSectionAvailable("appearance", effectiveMap({}))).toBe(true);
    expect(isSettingsSectionAvailable("github", effectiveMap({}))).toBe(false);
  });
});

describe("resolveWorkspaceTabContributions", () => {
  it("resolves no workspace tabs until a first-party package contributes one", () => {
    expect(resolveWorkspaceTabContributions("code", effectiveMap({ board: true })).size).toBe(0);
  });
});

describe("resolveThreadPaneContributions", () => {
  it("resolves no thread panes until a first-party package contributes one", () => {
    expect(resolveThreadPaneContributions("code", effectiveMap({ board: true })).size).toBe(0);
  });
});

describe("resolveBoardViewContributions", () => {
  it("includes the thread-status view for work and code when the board plugin is effective", () => {
    const effective = effectiveMap({ board: true });
    expect(resolveBoardViewContributions("work", effective).has("thread-status")).toBe(true);
    expect(resolveBoardViewContributions("code", effective).has("thread-status")).toBe(true);
    expect(resolveBoardViewContributions("chat", effective).has("thread-status")).toBe(false);
  });

  it("omits the thread-status view when the board plugin is not effective", () => {
    expect(resolveBoardViewContributions("code", effectiveMap({ board: false })).size).toBe(0);
  });
});

describe("resolveAppearancePresetContributions", () => {
  it("includes the Octant preset only while the appearance pack is effective", () => {
    expect(
      resolveAppearancePresetContributions(effectiveMap({ "appearance-pack": true })).has("octant"),
    ).toBe(true);
    expect(
      resolveAppearancePresetContributions(effectiveMap({ "appearance-pack": false })).has(
        "octant",
      ),
    ).toBe(false);
  });

  it("keeps host built-in presets available when the appearance pack is not effective", () => {
    const effective = effectiveMap({ "appearance-pack": false });
    expect(isAppearancePresetAvailable("system", effective)).toBe(true);
    expect(isAppearancePresetAvailable("light", effective)).toBe(true);
    expect(isAppearancePresetAvailable("dark", effective)).toBe(true);
    expect(isAppearancePresetAvailable("octant", effective)).toBe(false);
  });
});

describe("resolvePreviewViewerContributions", () => {
  it("includes structured document kinds only while the preview plugin is effective", () => {
    const kinds = resolvePreviewViewerContributions(effectiveMap({ "preview-viewers": true }));
    expect(kinds.has("pdf")).toBe(true);
    expect(kinds.has("table")).toBe(true);
    expect(kinds.has("workbook")).toBe(true);
    expect(kinds.has("document")).toBe(true);
    expect(kinds.has("slides")).toBe(true);
    expect(resolvePreviewViewerContributions(effectiveMap({ "preview-viewers": false })).size).toBe(
      0,
    );
  });

  it("keeps host primitive viewers available when the preview plugin is not effective", () => {
    const effective = effectiveMap({ "preview-viewers": false });
    expect(isPreviewViewerAvailable("text", effective)).toBe(true);
    expect(isPreviewViewerAvailable("markdown", effective)).toBe(true);
    expect(isPreviewViewerAvailable("image", effective)).toBe(true);
    expect(isPreviewViewerAvailable("unsupported", effective)).toBe(true);
    expect(isPreviewViewerAvailable("pdf", effective)).toBe(false);
  });
});
