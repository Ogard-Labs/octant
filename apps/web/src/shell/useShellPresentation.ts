import { useCallback, useEffect, useState } from "react";
import type { OctantHostBridge, ResolvedSidebarMaterial } from "./hostBridge";

export function useResolvedMaterial(
  preference: "opaque" | "system",
  hostBridge: OctantHostBridge | undefined,
): ResolvedSidebarMaterial {
  const [material, setMaterial] = useState<ResolvedSidebarMaterial>("opaque");
  useEffect(() => {
    if (hostBridge === undefined) {
      setMaterial(preference === "system" ? "translucent" : "opaque");
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    setMaterial("opaque");
    if (preference === "system") {
      unsubscribe = hostBridge.subscribeResolvedMaterial((resolved) => {
        setMaterial(resolved === "translucent" ? "translucent" : "opaque");
      });
    }
    let preferenceRequest: Promise<void>;
    try {
      preferenceRequest = Promise.resolve(hostBridge.setSidebarMaterialPreference(preference));
    } catch {
      preferenceRequest = Promise.reject(new Error("Host preference request failed."));
    }
    void preferenceRequest.catch(() => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (!disposed) setMaterial("opaque");
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [hostBridge, preference]);
  return material;
}

/**
 * Extends translucency from the sidebar to the workspace background
 * (docs/decisions/0047). Reuses the sidebar's already-resolved material
 * rather than its own gate chain, so accessibility, performance, and
 * host-support checks apply identically to both surfaces: the workspace
 * never turns translucent when the sidebar itself did not.
 */
export function resolveWorkspaceMaterial(
  preference: "opaque" | "system",
  sidebarResolvedMaterial: ResolvedSidebarMaterial,
): ResolvedSidebarMaterial {
  return preference === "system" && sidebarResolvedMaterial === "translucent"
    ? "translucent"
    : "opaque";
}

/**
 * Tell the host whether it may check for updates on its own.
 *
 * The preference is persisted with the rest of the shell settings, and the host
 * process starts with automatic checks off, so this is what turns them on. That
 * ordering is deliberate: a host that defaulted to on would check once on every
 * launch before it learned the person had said not to.
 */
export function useAutomaticUpdateCheckSync(
  hostBridge: OctantHostBridge | undefined,
  automaticUpdateChecks: boolean | undefined,
): void {
  const setAutomatic = hostBridge?.setAutomaticAppUpdateChecks;
  useEffect(() => {
    if (setAutomatic === undefined || automaticUpdateChecks === undefined) return;
    void setAutomatic(automaticUpdateChecks).catch(() => undefined);
  }, [automaticUpdateChecks, setAutomatic]);
}

/**
 * Whether the host says native window vibrancy is applied right now. False on
 * remote clients and on hosts that never report it, so the native sidebar wash
 * only relaxes when something is genuinely frosting the desktop behind the
 * window.
 */
export function useHostReportedSidebarVibrancy(hostBridge: OctantHostBridge | undefined): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(false);
    if (hostBridge === undefined || hostBridge.subscribeResolvedSidebarVibrancy === undefined) {
      return;
    }
    const unsubscribe = hostBridge.subscribeResolvedSidebarVibrancy((vibrancy) => {
      setActive(vibrancy === "sidebar");
    });
    return () => {
      unsubscribe();
    };
  }, [hostBridge]);
  return active;
}

export function useSidebarVibrancySupported(hostBridge: OctantHostBridge | undefined): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    if (hostBridge === undefined || hostBridge.getHostCapabilities === undefined) {
      setSupported(false);
      return;
    }
    let disposed = false;
    const result = hostBridge.getHostCapabilities();
    if (result instanceof Promise) {
      result
        .then((capabilities) => {
          if (!disposed) setSupported(capabilities.sidebarVibrancySupported);
        })
        .catch(() => {
          if (!disposed) setSupported(false);
        });
    } else {
      setSupported(result.sidebarVibrancySupported);
    }
    return () => {
      disposed = true;
    };
  }, [hostBridge]);
  return supported;
}

export function useSidebarBackgroundFetcher(
  serverUrl: string,
  windowCapability: string | undefined,
): (backgroundId: string) => Promise<Blob> {
  return useCallback(
    async (backgroundId: string) => {
      const headers: Record<string, string> = {};
      if (windowCapability !== undefined) {
        headers["x-octant-window-capability"] = windowCapability;
      }
      const response = await fetch(`${serverUrl}/api/theme/sidebar-backgrounds/${backgroundId}`, {
        headers,
      });
      if (!response.ok) {
        throw new Error(`Sidebar background fetch failed: ${response.status}`);
      }
      return response.blob();
    },
    [serverUrl, windowCapability],
  );
}

export function useSidebarVibrancyModeSync(
  hostBridge: OctantHostBridge | undefined,
  vibrancyMode: "off" | "subtle" | "strong",
  supported: boolean,
): void {
  useEffect(() => {
    if (hostBridge === undefined || hostBridge.setSidebarVibrancyMode === undefined || !supported) {
      return;
    }
    void Promise.resolve(hostBridge.setSidebarVibrancyMode(vibrancyMode)).catch(() => {
      // Host may reject unsupported modes; ignore silently.
    });
  }, [hostBridge, vibrancyMode, supported]);
}

export function useNarrowViewport(): boolean {
  const query = "(max-width: 960px)";
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "octant.shell.sidebar-collapsed.v1";

export function readSidebarCollapsed(scope: { readonly localStorage?: Storage }): boolean {
  try {
    return scope.localStorage?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(
  scope: { readonly localStorage?: Storage },
  collapsed: boolean,
) {
  try {
    if (collapsed) scope.localStorage?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
    else scope.localStorage?.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
  } catch {
    // Presentation persistence is best-effort.
  }
}

export const MIN_BOTTOM_PANEL_HEIGHT = 160;
export const MAX_BOTTOM_PANEL_HEIGHT = 640;
export const DEFAULT_BOTTOM_PANEL_HEIGHT = 260;

export interface BottomPanelPresentation {
  readonly open: boolean;
  readonly height: number;
}

function bottomPanelStorageKey(windowId: string): string {
  return `octant.shell.bottom-panel.${windowId}.v1`;
}

export function readBottomPanelPresentation(
  scope: { readonly localStorage?: Storage },
  windowId: string,
): BottomPanelPresentation {
  try {
    const raw = scope.localStorage?.getItem(bottomPanelStorageKey(windowId));
    if (raw === undefined || raw === null) {
      return { open: false, height: DEFAULT_BOTTOM_PANEL_HEIGHT };
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { open: false, height: DEFAULT_BOTTOM_PANEL_HEIGHT };
    }
    const candidate = parsed as { readonly open?: unknown; readonly height?: unknown };
    return {
      open: candidate.open === true,
      height: clampBottomPanelHeight(candidate.height),
    };
  } catch {
    return { open: false, height: DEFAULT_BOTTOM_PANEL_HEIGHT };
  }
}

export function writeBottomPanelPresentation(
  scope: { readonly localStorage?: Storage },
  windowId: string,
  presentation: BottomPanelPresentation,
): void {
  try {
    scope.localStorage?.setItem(
      bottomPanelStorageKey(windowId),
      JSON.stringify({
        open: presentation.open,
        height: clampBottomPanelHeight(presentation.height),
      }),
    );
  } catch {
    // Presentation persistence is best-effort.
  }
}

function clampBottomPanelHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BOTTOM_PANEL_HEIGHT;
  return Math.min(MAX_BOTTOM_PANEL_HEIGHT, Math.max(MIN_BOTTOM_PANEL_HEIGHT, Math.round(value)));
}
