import { describe, expect, it, vi } from "vitest";
import { NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT } from "@octant/contracts/shell";
import {
  COMPACT_TITLE_ROW_HEIGHT,
  INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
  MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT,
  createWindowPresentationController,
  describeGlassGate,
  glassSafeAtStart,
  resolveGlassRefusal,
  nativeTitlebarContainerHeight,
  observeThermalPerformance,
  resolveWindowPresentation,
  type NativeThemePort,
  type PowerMonitorPort,
  type PresentationWindowPort,
} from "./windowPresentation";

function system(overrides: Partial<Parameters<typeof resolveWindowPresentation>[0]> = {}) {
  return {
    platform: "darwin" as NodeJS.Platform,
    sidebarMaterial: "system" as const,
    sidebarVibrancyMode: "subtle" as const,
    compositionSupported: true,
    performanceSafe: true,
    prefersReducedTransparency: false,
    highContrast: false,
    ...overrides,
  };
}

describe("resolveWindowPresentation", () => {
  it("uses the supported macOS hidden-inset window without a custom traffic-light overlay", () => {
    const presentation = resolveWindowPresentation(system());
    expect(presentation).toEqual({
      interactiveTitlebarInset: NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT,
      browserWindow: {
        backgroundColor: "#00000000",
        titleBarStyle: "hiddenInset",
        transparent: true,
        vibrancy: "sidebar",
      },
      material: "translucent",
      vibrancy: "sidebar",
      glassRefusal: null,
    });
    expect(presentation.browserWindow).not.toHaveProperty("trafficLightPosition");
    expect(nativeTitlebarContainerHeight(undefined)).toBe("appkit-default");
  });

  it("does not enlarge NSTitlebarContainerView past the compact title row", () => {
    expect(nativeTitlebarContainerHeight(undefined)).toBe("appkit-default");
    expect(resolveWindowPresentation(system()).browserWindow).not.toHaveProperty(
      "trafficLightPosition",
    );
    // Electron WindowButtonsProxy: height = buttonHeight + 2 * y. The former
    // { x: 16, y: 18 } made a ~50px native overlay that covered the 34px row.
    expect(nativeTitlebarContainerHeight({ x: 16, y: 18 })).toBe(
      MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT + 2 * 18,
    );
    expect(nativeTitlebarContainerHeight({ x: 16, y: 18 })).toBeGreaterThan(
      COMPACT_TITLE_ROW_HEIGHT,
    );
    expect(NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT).toBeLessThanOrEqual(COMPACT_TITLE_ROW_HEIGHT);
  });

  it("constructs a window that resolves opaque without any vibrancy material", () => {
    expect(
      resolveWindowPresentation(system({ sidebarVibrancyMode: "off" })).browserWindow,
    ).not.toHaveProperty("vibrancy");
  });

  it("keeps an explicit native frame without macOS-only controls on non-macOS", () => {
    expect(resolveWindowPresentation(system({ platform: "linux" })).browserWindow).toEqual({
      backgroundColor: "#101013",
      frame: true,
    });
    expect(resolveWindowPresentation(system({ platform: "linux" }))).toMatchObject({
      interactiveTitlebarInset: 0,
    });
  });

  it.each([
    ["explicit opaque", { sidebarMaterial: "opaque" }],
    ["Reduce Transparency", { prefersReducedTransparency: true }],
    ["high contrast", { highContrast: true }],
    ["unsupported composition", { compositionSupported: false }],
    ["performance fallback", { performanceSafe: false }],
    ["non-macOS", { platform: "linux" }],
  ])("falls back to opaque for %s", (_name, override) => {
    expect(resolveWindowPresentation(system(override as never))).toMatchObject({
      material: "opaque",
      vibrancy: null,
    });
  });
});

describe("window presentation controller", () => {
  it("stays opaque under nominal thermal state until validated renderer authority requests system", () => {
    expect(INITIAL_SIDEBAR_MATERIAL_PREFERENCE).toBe("opaque");
    let thermalListener:
      | ((details: { state: "nominal" | "fair" | "serious" | "critical" | "unknown" }) => void)
      | undefined;
    const powerMonitor: PowerMonitorPort = {
      getCurrentThermalState: () => "nominal",
      on: (_event, listener) => {
        thermalListener = listener;
      },
      off: vi.fn(),
    };
    const nativeTheme: NativeThemePort = {
      prefersReducedTransparency: false,
      shouldUseHighContrastColors: false,
      on: vi.fn(),
      off: vi.fn(),
    };
    const window: PresentationWindowPort = {
      setVibrancy: vi.fn(),
      publishResolvedMaterial: vi.fn(),
      publishSidebarVibrancy: vi.fn(),
      publishGlassRefusal: vi.fn(),
    };
    const controller = createWindowPresentationController({
      window,
      nativeTheme,
      platform: "darwin",
      sidebarMaterial: INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
      sidebarVibrancyMode: "subtle",
      compositionSupported: true,
      performanceSafe: false,
    });
    const stopThermal = observeThermalPerformance({
      platform: "darwin",
      powerMonitor,
      updatePerformanceSafe: (performanceSafe) => controller.update({ performanceSafe }),
    });

    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.publishResolvedMaterial).toHaveBeenLastCalledWith("opaque");
    expect(window.publishSidebarVibrancy).toHaveBeenLastCalledWith(null);

    controller.update({ sidebarMaterial: "system" });
    expect(window.setVibrancy).toHaveBeenLastCalledWith("sidebar");
    expect(window.publishSidebarVibrancy).toHaveBeenLastCalledWith("sidebar");

    controller.update({ sidebarMaterial: "opaque" });
    thermalListener?.({ state: "fair" });
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.publishSidebarVibrancy).toHaveBeenLastCalledWith(null);

    stopThermal();
    controller.dispose();
  });

  it("refreshes mutable preference and performance inputs without overriding host constraints", () => {
    let listener: (() => void) | undefined;
    const nativeTheme: NativeThemePort = {
      prefersReducedTransparency: false,
      shouldUseHighContrastColors: false,
      on: vi.fn((_event, next) => {
        listener = next;
      }),
      off: vi.fn(),
    };
    const window: PresentationWindowPort = {
      setVibrancy: vi.fn(),
      publishResolvedMaterial: vi.fn(),
      publishSidebarVibrancy: vi.fn(),
      publishGlassRefusal: vi.fn(),
    };

    const controller = createWindowPresentationController({
      window,
      nativeTheme,
      platform: "darwin",
      sidebarMaterial: "system",
      sidebarVibrancyMode: "subtle",
      compositionSupported: true,
      performanceSafe: true,
    });
    expect(window.setVibrancy).toHaveBeenLastCalledWith("sidebar");
    expect(window.publishResolvedMaterial).toHaveBeenLastCalledWith("translucent");
    expect(window.publishSidebarVibrancy).toHaveBeenLastCalledWith("sidebar");

    controller.update({ sidebarMaterial: "opaque" });
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.publishResolvedMaterial).toHaveBeenLastCalledWith("opaque");

    controller.update({ sidebarMaterial: "system", performanceSafe: false });
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.publishResolvedMaterial).toHaveBeenLastCalledWith("opaque");

    controller.update({ performanceSafe: true });
    expect(window.setVibrancy).toHaveBeenLastCalledWith("sidebar");

    Object.assign(nativeTheme, { prefersReducedTransparency: true });
    listener?.();
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.publishResolvedMaterial).toHaveBeenLastCalledWith("opaque");
    expect(window.publishSidebarVibrancy).toHaveBeenLastCalledWith(null);

    controller.update({ sidebarMaterial: "system", performanceSafe: true });
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);

    controller.dispose();
    expect(nativeTheme.off).toHaveBeenCalledWith("updated", listener);
  });
});

describe("observeThermalPerformance", () => {
  it("maps nominal/fair to safe and serious/critical to opaque performance fallback", () => {
    let listener:
      | ((details: { state: "nominal" | "fair" | "serious" | "critical" | "unknown" }) => void)
      | undefined;
    const powerMonitor: PowerMonitorPort = {
      getCurrentThermalState: vi.fn(() => "fair" as const),
      on: vi.fn((_event, next) => {
        listener = next;
      }),
      off: vi.fn(),
    };
    const updatePerformanceSafe = vi.fn();

    const stop = observeThermalPerformance({
      platform: "darwin",
      powerMonitor,
      updatePerformanceSafe,
    });

    expect(updatePerformanceSafe).toHaveBeenLastCalledWith(true);
    listener?.({ state: "serious" });
    expect(updatePerformanceSafe).toHaveBeenLastCalledWith(false);
    listener?.({ state: "critical" });
    expect(updatePerformanceSafe).toHaveBeenLastCalledWith(false);
    listener?.({ state: "nominal" });
    expect(updatePerformanceSafe).toHaveBeenLastCalledWith(true);
    listener?.({ state: "fair" });
    expect(updatePerformanceSafe).toHaveBeenLastCalledWith(true);
    listener?.({ state: "unknown" });
    expect(updatePerformanceSafe).toHaveBeenLastCalledWith(false);

    stop();
    expect(powerMonitor.off).toHaveBeenCalledWith("thermal-state-change", listener);
  });

  it("starts a cool Mac's window without a thermal refusal, and a hot one with it", () => {
    const at = (state: "nominal" | "serious") => ({ getCurrentThermalState: () => state });
    expect(glassSafeAtStart("darwin", at("nominal"))).toBe(true);
    expect(glassSafeAtStart("darwin", at("serious"))).toBe(false);
    expect(glassSafeAtStart("linux", at("nominal"))).toBe(false);
  });
});

describe("why Glass is refused", () => {
  it.each([
    ["nothing in the way", {}, null],
    ["not macOS", { platform: "linux" }, "unsupported-platform"],
    ["no composition", { compositionSupported: false }, "unsupported-platform"],
    ["Reduce transparency", { prefersReducedTransparency: true }, "reduced-transparency"],
    ["Increase contrast", { highContrast: true }, "increased-contrast"],
    ["thermal pressure", { performanceSafe: false }, "thermal-pressure"],
  ])("names the reason for %s", (_name, override, reason) => {
    expect(resolveGlassRefusal(system(override as never))).toBe(reason);
    expect(resolveWindowPresentation(system(override as never)).glassRefusal).toBe(reason);
  });

  it("names the refusal whatever the person chose, so Settings can say why", () => {
    expect(
      resolveWindowPresentation(system({ sidebarVibrancyMode: "off", performanceSafe: false }))
        .glassRefusal,
    ).toBe("thermal-pressure");
  });

  it("publishes the reason with the material and logs each change of the gate's inputs once", () => {
    const lines: string[] = [];
    const nativeTheme: NativeThemePort = {
      prefersReducedTransparency: false,
      shouldUseHighContrastColors: false,
      on: vi.fn(),
      off: vi.fn(),
    };
    const window: PresentationWindowPort = {
      setVibrancy: vi.fn(),
      publishResolvedMaterial: vi.fn(),
      publishSidebarVibrancy: vi.fn(),
      publishGlassRefusal: vi.fn(),
    };
    const controller = createWindowPresentationController({
      window,
      nativeTheme,
      platform: "darwin",
      sidebarMaterial: "system",
      sidebarVibrancyMode: "strong",
      compositionSupported: true,
      performanceSafe: false,
      report: (line) => lines.push(line),
    });
    expect(window.publishGlassRefusal).toHaveBeenLastCalledWith("thermal-pressure");
    controller.refresh();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("performanceSafe=false");
    expect(lines[0]).toContain("refused: thermal-pressure");

    controller.update({ performanceSafe: true });
    expect(window.publishGlassRefusal).toHaveBeenLastCalledWith(null);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("-> translucent");
  });

  it("describes every input the gate read and nothing else", () => {
    const line = describeGlassGate(system(), resolveWindowPresentation(system()));
    expect(line).toBe(
      "[octant] window glass gate: platform=darwin material=system mode=subtle composition=true performanceSafe=true reducedTransparency=false increasedContrast=false -> translucent",
    );
  });
});

describe("the thermal gate", () => {
  it("does not ask the system's rich-animation hint, which reads false over screen sharing", () => {
    const powerMonitor: PowerMonitorPort = {
      getCurrentThermalState: () => "nominal",
      on: vi.fn(),
      off: vi.fn(),
    };
    const lines: string[] = [];
    const updatePerformanceSafe = vi.fn();
    observeThermalPerformance({
      platform: "darwin",
      powerMonitor,
      updatePerformanceSafe,
      report: (line) => lines.push(line),
    });
    expect(updatePerformanceSafe).toHaveBeenLastCalledWith(true);
    expect(lines).toEqual(["[octant] window glass gate: thermalState=nominal"]);
  });
});

describe("sidebar vibrancy mode", () => {
  it("off disables the native system sidebar material", () => {
    const presentation = resolveWindowPresentation(system({ sidebarVibrancyMode: "off" }));
    expect(presentation).toMatchObject({ material: "opaque", vibrancy: null });
  });

  it("subtle resolves vibrancy sidebar", () => {
    const presentation = resolveWindowPresentation(system({ sidebarVibrancyMode: "subtle" }));
    expect(presentation.vibrancy).toBe("sidebar");
  });

  it("strong resolves vibrancy sidebar", () => {
    const presentation = resolveWindowPresentation(system({ sidebarVibrancyMode: "strong" }));
    expect(presentation.vibrancy).toBe("sidebar");
  });

  it("reduced transparency forces vibrancy off regardless of mode", () => {
    const presentation = resolveWindowPresentation(
      system({ sidebarVibrancyMode: "strong", prefersReducedTransparency: true }),
    );
    expect(presentation.vibrancy).toBeNull();
  });

  it("high contrast forces vibrancy off regardless of mode", () => {
    const presentation = resolveWindowPresentation(
      system({ sidebarVibrancyMode: "strong", highContrast: true }),
    );
    expect(presentation.vibrancy).toBeNull();
  });

  it("non-darwin platform forces vibrancy off regardless of mode", () => {
    const presentation = resolveWindowPresentation(
      system({ platform: "linux", sidebarVibrancyMode: "strong" }),
    );
    expect(presentation.vibrancy).toBeNull();
  });
});
