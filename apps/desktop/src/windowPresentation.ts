import { NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT } from "@octant/contracts/shell";

export type ResolvedSidebarMaterial = "opaque" | "translucent";
export const INITIAL_SIDEBAR_MATERIAL_PREFERENCE = "opaque" as const;

/**
 * AppKit close-button frame height. Electron's WindowButtonsProxy uses this
 * when a custom `trafficLightPosition` is set:
 * `NSTitlebarContainerView.height = buttonHeight + 2 * y`.
 */
export const MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT = 14;

/** Compact title row the renderer paints under macOS hiddenInset. */
export const COMPACT_TITLE_ROW_HEIGHT = 34;

export type TrafficLightPosition = { readonly x: number; readonly y: number };

/**
 * Native overlay height Electron will give the titlebar container. `undefined`
 * means we never called `setMargin`, so AppKit keeps the default hiddenInset
 * container instead of growing one to `buttonHeight + 2 * y`.
 */
export function nativeTitlebarContainerHeight(
  trafficLightPosition: TrafficLightPosition | undefined,
): number | "appkit-default" {
  if (trafficLightPosition === undefined) return "appkit-default";
  return MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT + 2 * trafficLightPosition.y;
}

export interface WindowPresentationInput {
  readonly platform: NodeJS.Platform;
  readonly sidebarMaterial: "opaque" | "system";
  readonly sidebarVibrancyMode: "off" | "subtle" | "strong";
  readonly compositionSupported: boolean;
  readonly performanceSafe: boolean;
  readonly prefersReducedTransparency: boolean;
  readonly highContrast: boolean;
}

export interface WindowPresentation {
  /** CSS pixels reserved by macOS hiddenInset before renderer hit targets. */
  readonly interactiveTitlebarInset: number;
  readonly browserWindow:
    | {
        readonly backgroundColor: "#00000000";
        readonly titleBarStyle: "hiddenInset";
        readonly transparent: true;
        readonly vibrancy?: "sidebar";
      }
    | {
        readonly backgroundColor: "#101013";
        readonly frame: true;
      };
  readonly material: ResolvedSidebarMaterial;
  readonly vibrancy: "sidebar" | null;
}

export interface NativeThemePort {
  readonly prefersReducedTransparency: boolean;
  readonly shouldUseHighContrastColors: boolean;
  readonly on: (event: "updated", listener: () => void) => void;
  readonly off: (event: "updated", listener: () => void) => void;
}

export interface PresentationWindowPort {
  readonly setVibrancy: (vibrancy: "sidebar" | null) => void;
  readonly publishResolvedMaterial: (material: ResolvedSidebarMaterial) => void;
  /**
   * Tells the renderer whether native window vibrancy is actually applied.
   * The renderer keeps a near-opaque sidebar wash until the host says so,
   * because a translucent CSS material over a transparent window shows the
   * desktop behind it sharp when nothing is frosting it natively.
   */
  readonly publishSidebarVibrancy: (vibrancy: "sidebar" | null) => void;
}

interface CreateWindowPresentationControllerOptions {
  readonly window: PresentationWindowPort;
  readonly nativeTheme: NativeThemePort;
  readonly platform: NodeJS.Platform;
  readonly sidebarMaterial: "opaque" | "system";
  readonly sidebarVibrancyMode: "off" | "subtle" | "strong";
  readonly compositionSupported: boolean;
  readonly performanceSafe: boolean;
}

export interface WindowPresentationController {
  readonly refresh: () => WindowPresentation;
  readonly update: (
    input: Partial<
      Pick<WindowPresentationInput, "sidebarMaterial" | "performanceSafe" | "sidebarVibrancyMode">
    >,
  ) => WindowPresentation;
  readonly dispose: () => void;
}

export type ThermalState = "critical" | "fair" | "nominal" | "serious" | "unknown";

export interface PowerMonitorPort {
  readonly getCurrentThermalState: () => ThermalState;
  readonly on: (
    event: "thermal-state-change",
    listener: (details: { readonly state: ThermalState }) => void,
  ) => unknown;
  readonly off: (
    event: "thermal-state-change",
    listener: (details: { readonly state: ThermalState }) => void,
  ) => unknown;
}

export function resolveWindowPresentation(input: WindowPresentationInput): WindowPresentation {
  const translucent =
    input.platform === "darwin" &&
    input.sidebarMaterial === "system" &&
    input.sidebarVibrancyMode !== "off" &&
    input.compositionSupported &&
    input.performanceSafe &&
    !input.prefersReducedTransparency &&
    !input.highContrast;
  return {
    interactiveTitlebarInset: input.platform === "darwin" ? NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT : 0,
    browserWindow:
      input.platform === "darwin"
        ? {
            backgroundColor: "#00000000",
            // Omit trafficLightPosition: specifying y resizes NSTitlebarContainerView
            // to buttonHeight + 2*y and that native overlay eats title-row clicks.
            titleBarStyle: "hiddenInset",
            transparent: true,
            // A window constructed while the translucent conditions already
            // hold gets its NSVisualEffectView from the first frame instead of
            // waiting for the controller's runtime setVibrancy refresh.
            ...(translucent ? { vibrancy: "sidebar" as const } : {}),
          }
        : {
            backgroundColor: "#101013",
            frame: true,
          },
    material: translucent ? "translucent" : "opaque",
    vibrancy: translucent ? "sidebar" : null,
  };
}

export function createWindowPresentationController(
  options: CreateWindowPresentationControllerOptions,
): WindowPresentationController {
  let sidebarMaterial = options.sidebarMaterial;
  let sidebarVibrancyMode = options.sidebarVibrancyMode;
  let performanceSafe = options.performanceSafe;
  const refresh = () => {
    const presentation = resolveWindowPresentation({
      platform: options.platform,
      sidebarMaterial,
      sidebarVibrancyMode,
      compositionSupported: options.compositionSupported,
      performanceSafe,
      prefersReducedTransparency: options.nativeTheme.prefersReducedTransparency,
      highContrast: options.nativeTheme.shouldUseHighContrastColors,
    });
    options.window.setVibrancy(presentation.vibrancy);
    options.window.publishResolvedMaterial(presentation.material);
    options.window.publishSidebarVibrancy(presentation.vibrancy);
    return presentation;
  };
  options.nativeTheme.on("updated", refresh);
  refresh();
  return {
    refresh,
    update: (input) => {
      if (input.sidebarMaterial !== undefined) sidebarMaterial = input.sidebarMaterial;
      if (input.performanceSafe !== undefined) performanceSafe = input.performanceSafe;
      if (input.sidebarVibrancyMode !== undefined) sidebarVibrancyMode = input.sidebarVibrancyMode;
      return refresh();
    },
    dispose: () => options.nativeTheme.off("updated", refresh),
  };
}

interface ObserveThermalPerformanceOptions {
  readonly platform: NodeJS.Platform;
  readonly powerMonitor: PowerMonitorPort;
  readonly richEffectsAllowed: boolean;
  readonly updatePerformanceSafe: (safe: boolean) => void;
}

export function observeThermalPerformance(options: ObserveThermalPerformanceOptions): () => void {
  if (options.platform !== "darwin") {
    options.updatePerformanceSafe(false);
    return () => undefined;
  }
  const update = ({ state }: { readonly state: ThermalState }) => {
    options.updatePerformanceSafe(
      options.richEffectsAllowed && (state === "nominal" || state === "fair"),
    );
  };
  options.powerMonitor.on("thermal-state-change", update);
  update({ state: options.powerMonitor.getCurrentThermalState() });
  return () => options.powerMonitor.off("thermal-state-change", update);
}
