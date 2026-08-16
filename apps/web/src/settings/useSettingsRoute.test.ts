import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SettingsDeepLink } from "@octant/contracts";
import {
  createSettingsRegistry,
  listAvailableSections,
  settingId,
  type SettingsNativeCapabilities,
  type SettingsRegistry,
} from "./registry";
import { useSettingsRoute } from "./useSettingsRoute";

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
        keywords: "",
        settings: [
          { id: settingId("enable-chat"), label: "Enable Chat", scope: "app", keywords: "" },
        ],
      },
      {
        id: "appearance",
        label: "Appearance",
        scope: "app",
        keywords: "",
        nativeRequired: "sidebarVibrancySupported",
        settings: [
          { id: settingId("sidebar-width"), label: "Sidebar width", scope: "app", keywords: "" },
        ],
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
}

interface RouteFixture {
  readonly registry: SettingsRegistry;
  readonly capabilities: SettingsNativeCapabilities;
  readonly available: ReturnType<typeof listAvailableSections>;
}

function buildFixture(capabilities: SettingsNativeCapabilities = ALL_CAPABLE): RouteFixture {
  const registry = buildRegistry();
  return { registry, capabilities, available: listAvailableSections(registry, capabilities) };
}

function renderRoute(fixture: RouteFixture, initialDeepLink?: SettingsDeepLink) {
  return renderHook(() =>
    useSettingsRoute({
      availableSections: fixture.available,
      capabilities: fixture.capabilities,
      registry: fixture.registry,
      ...(initialDeepLink === undefined ? {} : { initialDeepLink }),
    }),
  );
}

describe("useSettingsRoute", () => {
  it("defaults to the first available section with no focused setting", () => {
    const { result } = renderRoute(buildFixture());

    expect(result.current.activeSection).toBe("general");
    expect(result.current.focusedSetting).toBeUndefined();
  });

  it("openSection switches the active section and clears focus", () => {
    const { result } = renderRoute(buildFixture());

    act(() => result.current.focusSetting("enable-chat"));
    expect(result.current.focusedSetting).toBe("enable-chat");

    act(() => result.current.openSection("appearance"));
    expect(result.current.activeSection).toBe("appearance");
    expect(result.current.focusedSetting).toBeUndefined();
  });

  it("openSection ignores an unavailable section id", () => {
    const { result } = renderRoute(buildFixture());

    act(() => result.current.openSection("skills" as never));
    expect(result.current.activeSection).toBe("general");
  });

  it("focusSetting sets the focused setting without changing the section", () => {
    const { result } = renderRoute(buildFixture());

    act(() => result.current.focusSetting("enable-chat"));
    expect(result.current.activeSection).toBe("general");
    expect(result.current.focusedSetting).toBe("enable-chat");
  });

  it("applyDeepLink opens the linked section and focuses the linked setting", () => {
    const { result } = renderRoute(buildFixture());
    const link: SettingsDeepLink = { section: "appearance", setting: "sidebar-width" };

    act(() => result.current.applyDeepLink(link));

    expect(result.current.activeSection).toBe("appearance");
    expect(result.current.focusedSetting).toBe("sidebar-width");
  });

  it("applyDeepLink opens a section-only link without focusing a setting", () => {
    const { result } = renderRoute(buildFixture());
    const link: SettingsDeepLink = { section: "providers" };

    act(() => result.current.applyDeepLink(link));

    expect(result.current.activeSection).toBe("providers");
    expect(result.current.focusedSetting).toBeUndefined();
  });

  it("applyDeepLink falls back to the section when the setting is unknown", () => {
    const { result } = renderRoute(buildFixture());
    const link: SettingsDeepLink = { section: "appearance", setting: "nope" };

    act(() => result.current.applyDeepLink(link));

    expect(result.current.activeSection).toBe("appearance");
    expect(result.current.focusedSetting).toBeUndefined();
  });

  it("applyDeepLink ignores a link to an unavailable section", () => {
    const { result } = renderRoute(buildFixture());

    act(() => result.current.applyDeepLink({ section: "skills" as never }));
    expect(result.current.activeSection).toBe("general");
  });

  it("applies an initial deep link on mount", () => {
    const initialLink: SettingsDeepLink = { section: "providers" };
    const { result } = renderRoute(buildFixture(), initialLink);

    expect(result.current.activeSection).toBe("providers");
  });

  it("clamps to the first available section when the active section becomes unavailable", () => {
    const full = buildFixture(ALL_CAPABLE);
    const narrowed = buildFixture({
      nativeBoundsAvailable: true,
      sidebarVibrancySupported: false,
    });
    // appearance is present in `full` but dropped in `narrowed`.
    expect(full.available.some((s) => s.id === "appearance")).toBe(true);
    expect(narrowed.available.some((s) => s.id === "appearance")).toBe(false);

    const { result, rerender } = renderHook(
      ({ fixture }: { fixture: RouteFixture }) =>
        useSettingsRoute({
          availableSections: fixture.available,
          capabilities: fixture.capabilities,
          registry: fixture.registry,
        }),
      { initialProps: { fixture: full } },
    );

    act(() => result.current.openSection("appearance"));
    expect(result.current.activeSection).toBe("appearance");

    rerender({ fixture: narrowed });
    expect(result.current.activeSection).toBe("general");
    expect(result.current.focusedSetting).toBeUndefined();
  });

  it("clearFocus clears the focused setting", () => {
    const { result } = renderRoute(buildFixture());

    act(() => result.current.focusSetting("enable-chat"));
    act(() => result.current.clearFocus());
    expect(result.current.focusedSetting).toBeUndefined();
  });
});
