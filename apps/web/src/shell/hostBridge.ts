import type { OpenInApplicationId } from "@octant/contracts/shell";

export type ResolvedSidebarMaterial = "opaque" | "translucent";
export type BoundProjectType = "work" | "code";
export type ProviderCredentialStatus = "stored" | "missing" | "unavailable";
export type ProjectRootPickerResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; receiptId: string; displayName: string }>;
export type LocalPluginFolderPickerResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; receiptId: string; displayName: string }>;
export interface CodeExternalEditorRequest {
  readonly threadId: string;
  readonly checkoutId: string;
  readonly fileId: string;
  readonly line: number;
  readonly column: number;
}
export interface OpenInApplicationDescriptor {
  readonly id: OpenInApplicationId;
  readonly label: string;
  readonly available: boolean;
}
export interface CodeCheckoutOpenRequest {
  readonly threadId: string;
  readonly applicationId: OpenInApplicationId;
}
export type CodeDeepLink =
  | Readonly<{ kind: "project"; projectId: string }>
  | Readonly<{ kind: "thread"; threadId: string }>
  | Readonly<{ kind: "diff"; threadId: string; checkoutId: string }>
  | Readonly<{ kind: "test"; threadId: string; testRunId: string }>
  | Readonly<{
      kind: "file";
      threadId: string;
      checkoutId: string;
      fileId: string;
      relativePath: string;
      line: number;
      column: number;
    }>
  | Readonly<{ kind: "new-thread"; projectId: string; checkoutId: string }>;

export interface HostCapabilities {
  readonly sidebarVibrancySupported: boolean;
  readonly liveBrowserSupported?: boolean;
  readonly liveSimulatorFrameSupported?: boolean;
}

export interface BrowserSurfaceTabState {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
}

export interface BrowserSurfaceState {
  readonly contextId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly control: "idle" | "user" | "agent";
  /**
   * Every page open in this context. Older hosts report no tabs at all, so a
   * rail reads an absent list as the one page it already shows.
   */
  readonly tabs?: ReadonlyArray<BrowserSurfaceTabState>;
  readonly activeTabId?: string;
}

import type { AppUpdateState as AppUpdateStateView } from "@octant/contracts/app-updates";

export type { AppUpdateStateView };

export interface AppUpdateReleaseView {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly url: string;
  readonly sha256: string;
  readonly releasedAt: string;
  readonly notes?: string;
}

/**
 * What the host is still busy with, as it already reports it for the quit
 * guard. The renderer never supplies this — the host reads it itself.
 */
export type AppUpdateInstallOutcome =
  | { readonly kind: "installing" }
  | {
      readonly kind: "wait";
      readonly activeAgentCount: number;
      readonly attentionRequired: boolean;
    }
  | { readonly kind: "not-ready" };

export type BrowserSurfaceTabCommand =
  | { readonly kind: "open" }
  | { readonly kind: "select"; readonly tabId: string }
  | { readonly kind: "close"; readonly tabId: string };

export interface BrowserSurfaceRequest {
  readonly contextId: string;
  readonly threadId: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export type ProjectWindowTarget =
  | Readonly<{ kind: "project"; projectId: string }>
  | Readonly<{
      kind: "project-thread";
      projectId: string;
      mode: "code" | "work";
      threadId: string;
    }>;

export type AttentionReason = "turn-finished" | "approval-required" | "question-asked";

export interface AttentionNotificationRequest {
  readonly reason: AttentionReason;
  readonly threadTitle: string;
  readonly detail?: string;
}

export interface OctantHostBridge {
  readonly notifyAttention?: (request: AttentionNotificationRequest) => Promise<void>;
  readonly setAttentionBadge?: (count: number) => Promise<void>;
  readonly attachBrowserSurface?: (request: BrowserSurfaceRequest) => Promise<BrowserSurfaceState>;
  readonly updateBrowserSurfaceBounds?: (request: BrowserSurfaceRequest) => Promise<void>;
  readonly detachBrowserSurface?: (request: Omit<BrowserSurfaceRequest, "bounds">) => Promise<void>;
  readonly commandBrowserSurface?: (
    request: Omit<BrowserSurfaceRequest, "bounds"> & {
      readonly command: "back" | "forward" | "reload" | "stop";
    },
  ) => Promise<void>;
  readonly tabBrowserSurface?: (
    request: Omit<BrowserSurfaceRequest, "bounds"> & {
      readonly command: BrowserSurfaceTabCommand;
    },
  ) => Promise<BrowserSurfaceState>;
  /**
   * The desktop app's own update path. Absent on a remote client, which is
   * served by a host it does not update.
   */
  readonly checkForAppUpdate?: () => Promise<AppUpdateStateView>;
  readonly downloadAppUpdate?: () => Promise<AppUpdateStateView>;
  readonly installAppUpdate?: () => Promise<AppUpdateInstallOutcome>;
  readonly setAutomaticAppUpdateChecks?: (enabled: boolean) => Promise<AppUpdateStateView>;
  readonly subscribeAppUpdateState?: (listener: (state: AppUpdateStateView) => void) => () => void;
  readonly openBrowserExternal?: (url: string) => Promise<void>;
  readonly subscribeBrowserSurfaceState?: (
    listener: (state: BrowserSurfaceState) => void,
  ) => () => void;
  readonly clearProviderCredential: (providerInstanceId: string) => Promise<void>;
  readonly close: () => Promise<void> | void;
  readonly getHostCapabilities?: () => HostCapabilities | Promise<HostCapabilities>;
  /**
   * The chrome the host actually gave this window. Only the macOS hiddenInset
   * presentation leaves the titlebar area to the renderer; a system-framed
   * window already draws its own titlebar, so reserving the inset there wastes
   * a strip of the window and lays a drag region over the real title bar.
   * Absent on a host that does not report it, which is read as system frame.
   */
  readonly windowChrome?: "hidden-inset" | "system-frame";
  readonly initialProjectTarget?: ProjectWindowTarget;
  readonly maximizeOrRestore: () => Promise<void> | void;
  readonly minimize: () => Promise<void> | void;
  readonly openCodeExternalEditor?: (request: CodeExternalEditorRequest) => Promise<void>;
  readonly listOpenInApplications?: () => Promise<ReadonlyArray<OpenInApplicationDescriptor>>;
  readonly openCodeCheckoutInApplication?: (request: CodeCheckoutOpenRequest) => Promise<void>;
  readonly openInNewWindow?: (target: ProjectWindowTarget) => Promise<void> | void;
  readonly requestCodeOperationApproval?: (
    request: CodeOperationApprovalRequest,
  ) => Promise<string | undefined>;
  readonly projectWindowCapability: string;
  readonly providerCredentialStatus: (
    providerInstanceId: string,
  ) => Promise<ProviderCredentialStatus>;
  readonly resetBounds: () => Promise<void> | void;
  readonly selectProjectRoot: (projectType: BoundProjectType) => Promise<ProjectRootPickerResult>;
  readonly selectLocalPluginFolder?: () => Promise<LocalPluginFolderPickerResult>;
  readonly setProviderCredential: (providerInstanceId: string, credential: string) => Promise<void>;
  readonly setSidebarMaterialPreference: (preference: "opaque" | "system") => Promise<void> | void;
  readonly setSidebarVibrancyMode?: (mode: "off" | "subtle" | "strong") => Promise<void> | void;
  readonly subscribeResolvedMaterial: (
    listener: (material: ResolvedSidebarMaterial) => void,
  ) => () => void;
  /**
   * The host's word that native window vibrancy is actually applied. The
   * renderer keeps its near-opaque native sidebar wash until this reports
   * "sidebar", because CSS backdrop-filter cannot frost another app's window —
   * translucency without host vibrancy shows the desktop behind sharp. Absent
   * on hosts that never apply vibrancy.
   */
  readonly subscribeResolvedSidebarVibrancy?: (
    listener: (vibrancy: "sidebar" | null) => void,
  ) => () => void;
  readonly subscribeCodeDeepLinks?: (listener: (target: CodeDeepLink) => void) => () => void;
  readonly subscribeOpenSettings?: (listener: () => void) => () => void;
  readonly subscribeStartNewAgent?: (listener: () => void) => () => void;
}

declare global {
  interface Window {
    readonly octantHost?: OctantHostBridge;
  }
}

export interface HostBridgeGlobal {
  readonly octantHost?: unknown;
}

export function getInjectedHostBridge(
  host: HostBridgeGlobal = window,
): OctantHostBridge | undefined {
  const bridge = host.octantHost;
  if (bridge === undefined) return undefined;
  if (
    typeof bridge !== "object" ||
    bridge === null ||
    typeof (bridge as Record<string, unknown>).setProviderCredential !== "function" ||
    typeof (bridge as Record<string, unknown>).providerCredentialStatus !== "function" ||
    typeof (bridge as Record<string, unknown>).clearProviderCredential !== "function"
  ) {
    throw new TypeError("Invalid Octant host bridge.");
  }
  return bridge as OctantHostBridge;
}
import type { CodeOperationApprovalRequest } from "@octant/contracts/code-operations";
