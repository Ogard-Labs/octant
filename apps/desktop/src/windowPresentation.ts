export type ResolvedSidebarMaterial = "opaque" | "translucent";
export const INITIAL_SIDEBAR_MATERIAL_PREFERENCE = "opaque" as const;

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
  readonly browserWindow:
    | {
        readonly backgroundColor: "#00000000";
        readonly frame: false;
        readonly titleBarStyle: "hiddenInset";
        readonly trafficLightPosition: { readonly x: 16; readonly y: 18 };
        readonly transparent: true;
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
    browserWindow:
      input.platform === "darwin"
        ? {
            backgroundColor: "#00000000",
            frame: false,
            titleBarStyle: "hiddenInset",
            trafficLightPosition: { x: 16, y: 18 },
            transparent: true,
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
