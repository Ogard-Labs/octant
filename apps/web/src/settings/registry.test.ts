import { describe, expect, it } from "vitest";
import type { SettingsDeepLink, SettingsSectionId } from "@octant/contracts";
import {
  type SettingsNativeCapabilities,
  type SettingsRegistry,
  type SettingsScope,
  type SettingsSearchResult,
  createSettingsRegistry,
  filterSectionsForNavigator,
  findSection,
  findSetting,
  isSectionAvailable,
  listAvailableSections,
  normalizeSettingsQuery,
  resolveDeepLink,
  searchSettings,
  settingId,
} from "./registry";

const ALL_CAPABLE: SettingsNativeCapabilities = {
  nativeBoundsAvailable: true,
  sidebarVibrancySupported: true,
};

function buildRegistry(): SettingsRegistry {
  return createSettingsRegistry({
    sections: [
      {
        id: "general",
        label: "General",
        scope: "app",
        keywords: "general enabled modes startup chat work",
        settings: [
          {
            id: settingId("enable-chat"),
            label: "Enable Chat",
            scope: "app",
            keywords: "enable chat mode",
          },
          {
            id: settingId("enable-work"),
            label: "Enable Work",
            scope: "app",
            keywords: "enable work mode",
          },
        ],
      },
      {
        id: "appearance",
        label: "Appearance",
        scope: "app",
        keywords: "appearance theme sidebar translucency layout",
        settings: [
          {
            id: settingId("sidebar-width"),
            label: "Sidebar width",
            scope: "app",
            keywords: "sidebar width",
          },
          {
            id: settingId("sidebar-material"),
            label: "Translucent sidebar",
            scope: "app",
            keywords: "translucent sidebar material vibrancy",
            nativeRequired: "sidebarVibrancySupported",
          },
        ],
      },
      {
        id: "providers",
        label: "Providers & Models",
        scope: "app",
        keywords: "providers models connection api key",
        settings: [],
      },
    ],
  });
}

describe("normalizeSettingsQuery", () => {
  it("lowercases, collapses non-word chars, and trims", () => {
    expect(normalizeSettingsQuery("  Translucent  Sidebar!  ")).toBe("translucent sidebar");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeSettingsQuery("   ")).toBe("");
  });
});

describe("isSectionAvailable", () => {
  it("is available when no native capability is required", () => {
    const registry = buildRegistry();
    expect(isSectionAvailable(findSection(registry, "general")!, ALL_CAPABLE)).toBe(true);
  });

  it("is available when the required native capability is present", () => {
    const registry = buildRegistry();
    expect(isSectionAvailable(findSection(registry, "appearance")!, ALL_CAPABLE)).toBe(true);
  });

  it("is unavailable when a section-level native capability is missing", () => {
    const registry = createSettingsRegistry({
      sections: [
        {
          id: "appearance",
          label: "Appearance",
          scope: "app",
          keywords: "appearance",
          nativeRequired: "sidebarVibrancySupported",
          settings: [],
        },
      ],
    });
    expect(
      isSectionAvailable(registry.sections[0]!, {
        nativeBoundsAvailable: true,
        sidebarVibrancySupported: false,
      }),
    ).toBe(false);
  });
});

describe("listAvailableSections", () => {
  it("keeps only sections whose native requirements are met, in registry order", () => {
    const registry = createSettingsRegistry({
      sections: [
        {
          id: "general",
          label: "General",
          scope: "app",
          keywords: "",
          settings: [],
        },
        {
          id: "appearance",
          label: "Appearance",
          scope: "app",
          keywords: "",
          nativeRequired: "sidebarVibrancySupported",
          settings: [],
        },
        {
          id: "providers",
          label: "Providers & Models",
          scope: "app",
          keywords: "",
          settings: [],
        },
      ],
    });
    const available = listAvailableSections(registry, {
      nativeBoundsAvailable: true,
      sidebarVibrancySupported: false,
    });
    expect(available.map((s) => s.id)).toEqual(["general", "providers"]);
  });
});

describe("filterSectionsForNavigator", () => {
  it("returns all available sections for an empty query", () => {
    const registry = buildRegistry();
    const available = listAvailableSections(registry, ALL_CAPABLE);
    expect(filterSectionsForNavigator(available, ALL_CAPABLE, "").map((s) => s.id)).toEqual([
      "general",
      "appearance",
      "providers",
    ]);
  });

  it("returns only sections with a matching label, keyword, or setting for a query", () => {
    const registry = buildRegistry();
    const available = listAvailableSections(registry, ALL_CAPABLE);
    expect(
      filterSectionsForNavigator(available, ALL_CAPABLE, "translucent").map((s) => s.id),
    ).toEqual(["appearance"]);
    expect(
      filterSectionsForNavigator(available, ALL_CAPABLE, "enable work").map((s) => s.id),
    ).toEqual(["general"]);
    expect(
      filterSectionsForNavigator(available, ALL_CAPABLE, "providers").map((s) => s.id),
    ).toEqual(["providers"]);
  });

  it("returns no sections for a query matching nothing", () => {
    const registry = buildRegistry();
    const available = listAvailableSections(registry, ALL_CAPABLE);
    expect(filterSectionsForNavigator(available, ALL_CAPABLE, "zzz")).toEqual([]);
  });

  it("ignores settings gated by an unmet native capability when matching", () => {
    const registry = buildRegistry();
    const available = listAvailableSections(registry, {
      nativeBoundsAvailable: true,
      sidebarVibrancySupported: false,
    });
    expect(
      filterSectionsForNavigator(
        available,
        {
          nativeBoundsAvailable: true,
          sidebarVibrancySupported: false,
        },
        "translucent",
      ),
    ).toEqual([]);
  });
});

describe("searchSettings", () => {
  it("returns no results for an empty query", () => {
    const registry = buildRegistry();
    const available = listAvailableSections(registry, ALL_CAPABLE);
    expect(searchSettings(available, ALL_CAPABLE, "")).toEqual([]);
  });

  it("returns setting matches with their section reference", () => {
    const registry = buildRegistry();
    const available = listAvailableSections(registry, ALL_CAPABLE);
    const results = searchSettings(available, ALL_CAPABLE, "sidebar width");
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      kind: "setting",
      sectionId: "appearance",
      settingId: "sidebar-width",
      label: "Sidebar width",
      scope: "app",
    } satisfies SettingsSearchResult);
  });

  it("returns a section result when the section matches but no setting does", () => {
    const registry = buildRegistry();
    const available = listAvailableSections(registry, ALL_CAPABLE);
    const results = searchSettings(available, ALL_CAPABLE, "models");
    expect(results).toEqual([
      { kind: "section", sectionId: "providers", label: "Providers & Models", scope: "app" },
    ]);
  });

  it("does not return a section result when a setting within it already matched", () => {
    const registry = buildRegistry();
    const available = listAvailableSections(registry, ALL_CAPABLE);
    const results = searchSettings(available, ALL_CAPABLE, "translucent");
    expect(results.every((r) => r.kind === "setting")).toBe(true);
    expect(results.map((r) => (r.kind === "setting" ? r.settingId : r.sectionId))).toEqual([
      "sidebar-material",
    ]);
  });

  it("excludes settings gated by an unmet native capability", () => {
    const registry = buildRegistry();
    const capabilities = { nativeBoundsAvailable: true, sidebarVibrancySupported: false };
    const available = listAvailableSections(registry, capabilities);
    expect(searchSettings(available, capabilities, "translucent")).toEqual([]);
  });
});

describe("resolveDeepLink", () => {
  it("resolves a section-only deep link to an available section", () => {
    const registry = buildRegistry();
    const link: SettingsDeepLink = { section: "providers" };
    const resolved = resolveDeepLink(registry, ALL_CAPABLE, link);
    expect(resolved?.section.id).toBe("providers");
    expect(resolved?.settingId).toBeUndefined();
  });

  it("resolves a section plus setting deep link when the setting exists in that section", () => {
    const registry = buildRegistry();
    const link: SettingsDeepLink = { section: "appearance", setting: "sidebar-width" };
    const resolved = resolveDeepLink(registry, ALL_CAPABLE, link);
    expect(resolved?.section.id).toBe("appearance");
    expect(resolved?.settingId).toBe("sidebar-width");
  });

  it("returns undefined when the section is unavailable", () => {
    const registry = createSettingsRegistry({
      sections: [
        {
          id: "appearance",
          label: "Appearance",
          scope: "app",
          keywords: "",
          nativeRequired: "sidebarVibrancySupported",
          settings: [],
        },
      ],
    });
    const link: SettingsDeepLink = { section: "appearance" };
    expect(
      resolveDeepLink(
        registry,
        {
          nativeBoundsAvailable: true,
          sidebarVibrancySupported: false,
        },
        link,
      ),
    ).toBeUndefined();
  });

  it("falls back to the section when the setting is not found in that section", () => {
    const registry = buildRegistry();
    const link: SettingsDeepLink = { section: "appearance", setting: "nope" };
    const resolved = resolveDeepLink(registry, ALL_CAPABLE, link);
    expect(resolved?.section.id).toBe("appearance");
    expect(resolved?.settingId).toBeUndefined();
  });

  it("returns undefined when the section id is not in the registry", () => {
    const registry = buildRegistry();
    const link = { section: "skills" as SettingsSectionId };
    expect(resolveDeepLink(registry, ALL_CAPABLE, link)).toBeUndefined();
  });
});

describe("findSetting", () => {
  it("finds a setting within a section", () => {
    const registry = buildRegistry();
    const section = findSection(registry, "general")!;
    expect(findSetting(section, "enable-chat")?.label).toBe("Enable Chat");
  });

  it("returns undefined for an unknown setting", () => {
    const registry = buildRegistry();
    const section = findSection(registry, "general")!;
    expect(findSetting(section, "nope")).toBeUndefined();
  });
});

describe("createSettingsRegistry", () => {
  it("preserves section and setting order", () => {
    const registry = buildRegistry();
    expect(registry.sections.map((s) => s.id)).toEqual(["general", "appearance", "providers"]);
    expect(registry.sections[0]!.settings.map((s) => s.id)).toEqual(["enable-chat", "enable-work"]);
  });

  it("rejects a duplicate section id", () => {
    expect(() =>
      createSettingsRegistry({
        sections: [
          {
            id: "general",
            label: "General",
            scope: "app" as SettingsScope,
            keywords: "",
            settings: [],
          },
          {
            id: "general",
            label: "General 2",
            scope: "app" as SettingsScope,
            keywords: "",
            settings: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a duplicate setting id within a section", () => {
    expect(() =>
      createSettingsRegistry({
        sections: [
          {
            id: "general",
            label: "General",
            scope: "app" as SettingsScope,
            keywords: "",
            settings: [
              { id: settingId("enable-chat"), label: "Enable Chat", scope: "app", keywords: "" },
              { id: settingId("enable-chat"), label: "Enable Chat 2", scope: "app", keywords: "" },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});
