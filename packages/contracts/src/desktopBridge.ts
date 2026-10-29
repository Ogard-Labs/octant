import type { FleetActivityThread } from "./fleetActivity";
import type { OpenInApplicationId } from "./shell";

/**
 * The payload types of the desktop's contextBridge seam: one set of shapes the
 * main process, the sandboxed preload, and the renderer all import, so the
 * three bundles can never drift apart on the same DTO.
 *
 * The two Electron bundles and the web bundle each used to keep their own copy
 * of these shapes, and the copies had already drifted — one omitted the signed
 * `ring` from the update release, one made capabilities optional that the host
 * always provides — with no typecheck able to notice, because no bundle reads
 * another bundle's declarations. Only types live here: the channel map and the
 * request decodes stay in `apps/desktop/src/ipcChannels.ts`, because the
 * sandboxed preload may not import a runtime package.
 */

/** The thread a window shows, or the one a menu-bar row asks it to open. */
export interface MenuBarOpenThread {
  readonly mode: FleetActivityThread["mode"];
  readonly threadId: string;
}

export type ResolvedSidebarMaterial = "opaque" | "translucent";
export type SidebarMaterialPreference = "opaque" | "system";
export type SidebarVibrancyMode = "off" | "subtle" | "strong";

/** What the main process tells a window its platform can do. Always complete. */
export interface HostCapabilities {
  readonly sidebarVibrancySupported: boolean;
  readonly liveBrowserSupported: boolean;
  readonly liveSimulatorFrameSupported: boolean;
  readonly liveAndroidFrameSupported: boolean;
}

export type BoundProjectType = "work" | "code";
export type ProviderCredentialStatus = "stored" | "missing" | "unavailable";

/** A key's label and id. The secret stays with the host and is never returned. */
export interface ProviderApiKeySummary {
  readonly id: string;
  readonly label: string;
  /** The key a request sends first. Exactly one key per provider is active. */
  readonly active: boolean;
}

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

export type ProjectWindowTarget =
  | Readonly<{ kind: "project"; projectId: string }>
  | Readonly<{
      kind: "project-thread";
      projectId: string;
      mode: "code" | "work";
      threadId: string;
    }>;

/**
 * The palette a window's own theme resolved to, reported so the desktop-owned
 * approval view can draw the app the person is looking at instead of the
 * operating system's light or dark preference alone.
 */
export interface ApprovalSurfacePalette {
  readonly mode: "light" | "dark";
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly control: string;
  readonly controlHover: string;
  readonly accent: string;
  readonly accentForeground: string;
}

export interface CodeOperationApprovalBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type CodeOperationApprovalAnchor =
  | {
      readonly kind: "thread";
      readonly projectId: string;
      readonly threadId: string;
      readonly bounds: CodeOperationApprovalBounds;
    }
  | {
      readonly kind: "draft";
      readonly projectId: string;
      readonly composerId: string;
      readonly bounds: CodeOperationApprovalBounds;
    };

export type AttentionReason =
  | "turn-finished"
  | "approval-required"
  | "question-asked"
  | "follow-up-due";

export interface AttentionNotificationRequest {
  readonly reason: AttentionReason;
  readonly threadTitle: string;
  readonly detail?: string;
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
      readonly activityUnconfirmed: boolean;
    }
  | { readonly kind: "not-ready" };

/**
 * Bundled notes for the running desktop build. Absent on a remote client,
 * which must not fetch notes or pretend to update the Machine.
 */
export type BundledWhatsNew =
  | {
      readonly kind: "notes";
      readonly version: string;
      readonly text: string;
      readonly showAfterApply: boolean;
    }
  | {
      readonly kind: "empty";
      readonly version: string;
      readonly showAfterApply: false;
    };

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

export type CanvasPrototypeSurfacePreparation =
  | { readonly status: "ready" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface CanvasPrototypeOpenRequest {
  readonly surfaceId: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
}

export type CanvasPrototypeOpenResult =
  | { readonly status: "open" }
  | { readonly status: "refused"; readonly reason: string };

export type PrivateListenerExposureClass = "lan-private" | "tailscale";
export type PrivateListenerControlFailureCode =
  | "local-confirmation-required"
  | "invalid-bind"
  | "invalid-origin"
  | "invalid-tls"
  | "tls-key-exposed"
  | "occupied-port"
  | "interface-unavailable"
  | "bind-failed"
  | "shutdown-failed"
  | "unavailable";

export interface PrivateListenerPublicStatus {
  readonly enabled: boolean;
  readonly state: "disabled" | "ready" | "failed";
  readonly hostname: string | null;
  readonly port: number | null;
  readonly origin: string | null;
  readonly exposureClass: PrivateListenerExposureClass | null;
  readonly certificateFingerprint: string | null;
  readonly certificateReady: boolean;
  /** `self-made`: no browser can verify this listener, so Settings offers no browser link. */
  readonly certificateSource: "self-made" | "pasted" | null;
  /** The self-made certificate's key pin, which a pairing code carries; null otherwise. */
  readonly tlsPin: string | null;
  readonly errorCode?: PrivateListenerControlFailureCode;
}

export interface PrivateListenerEnableRequest {
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly localConfirmation: true;
}

export type RemoteDeviceSourceClass = "loopback" | "lan-private" | "tailscale" | "unknown";
export type RemotePairingTicketSourceClass = Exclude<RemoteDeviceSourceClass, "unknown">;
export type RemoteDeviceState = "active" | "revoked" | "expired";

export interface RemoteMintedPairingTicket {
  readonly ticketId: string;
  readonly ticketProof: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly sourceClass: RemotePairingTicketSourceClass;
}

export interface RemotePendingPairingRequest {
  readonly kind: "pending";
  readonly ticketId: string;
  readonly hostId: string;
  readonly deviceLabel: string;
  readonly deviceKeyFingerprint: string;
  readonly origin: string;
  readonly sourceClass: RemoteDeviceSourceClass;
  readonly comparisonCode: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export interface RemoteDeviceInventoryEntry {
  readonly hostId: string;
  readonly deviceId: string;
  readonly deviceKeyFingerprint: string;
  readonly deviceLabel: string;
  readonly origin: string;
  readonly protocolFloor: number;
  readonly credentialGeneration: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly state: RemoteDeviceState;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export interface RemoteCredentialOperationReceipt {
  readonly commandId: string;
  readonly result: "applied" | "already-applied";
  readonly occurredAt: string;
}

/** Another computer this desktop app paired with from its app pairing code. */
export interface PairedComputer {
  readonly origin: string;
  readonly displayName: string;
}

export type ForgetPairedComputerOutcome =
  | { readonly status: "forgotten"; readonly warning?: string }
  | { readonly status: "refused"; readonly message: string };

export type SettlePairedComputerOutcome =
  | { readonly status: "settled" }
  | { readonly status: "refused"; readonly message: string };

export type PairedComputerOutcome =
  | {
      readonly status: "verified";
      readonly computer: PairedComputer;
      /** The single-use ticket the code carried; this window claims it with its own device key. */
      readonly ticket: { readonly ticketId: string; readonly ticketProof: string };
      /** The certificate pin the code carried; public, and recorded with the device. */
      readonly pin: string;
    }
  | { readonly status: "refused"; readonly message: string };

/** One request to a listed paired computer; main checks it against a short allow list. */
export interface PairedComputerRequest {
  readonly origin: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export type PairedComputerAnswer =
  | {
      readonly status: "answered";
      readonly httpStatus: number;
      readonly headers: ReadonlyArray<readonly [string, string]>;
      readonly body: Uint8Array;
    }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "unreachable"; readonly message: string };
