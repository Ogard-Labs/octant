import type { CodeCheckoutId } from "@octant/contracts/code";
import type {
  CodeDebugConfigurationDigest,
  CodeDebugStartRefusalReason,
} from "@octant/contracts/code-debug";
import type { ExtensionComponentId, ExtensionContentDigest } from "@octant/contracts/extensions";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import type { ToolExtensionId } from "@octant/contracts/tool-actions";

/**
 * Whether a debug session may start for a Code thread, and how its capsule is
 * confined if it may. Canonical: docs/design/language-services.md § Approval
 * and starting.
 *
 * The thread, checkout, and reach checks a language read makes run before
 * this, and the host's confinement backend after it; nothing launches until
 * all pass. The decision reads only the facts of this start. Nothing from the
 * repository reaches it, so no file in the checkout can start a program or
 * widen what one may do.
 */

/** `other` is any host platform that is neither macOS nor Linux. */
export type DebugSessionHostPlatform = "macos" | "linux" | "windows" | "other";

/**
 * Who caused the start. Only the person at a local window starts a session:
 * a paired device and an agent are each refused, whatever the posture.
 */
export type DebugSessionStarter = "local-window" | "remote-device" | "agent";

/** One adapter in one package state: the state a configuration's approval covers. */
export interface DebugAdapterPackageState {
  readonly extensionId: ToolExtensionId;
  readonly componentId: ExtensionComponentId;
  readonly packageDigest: ExtensionContentDigest;
  /** Moves with every update, switch, trust change, and reinstall of the package. */
  readonly lifecycleVersion: number;
}

/** A person's confirmation of one configuration, as the host recorded it. */
export interface DebugConfigurationApproval {
  readonly configurationDigest: CodeDebugConfigurationDigest;
  readonly adapter: DebugAdapterPackageState;
  readonly scope:
    | { readonly kind: "checkout"; readonly checkoutId: CodeCheckoutId }
    | { readonly kind: "project" };
}

export interface DebugSessionStartRequest {
  readonly platform: DebugSessionHostPlatform;
  readonly mode: OctantMode;
  readonly posture: ProviderExecutionPolicy;
  readonly startedBy: DebugSessionStarter;
  readonly checkoutId: CodeCheckoutId;
  /** The digest of the configuration as it stands now. */
  readonly configurationDigest: CodeDebugConfigurationDigest;
  /** The configuration's adapter as it stands now. */
  readonly adapter: DebugAdapterPackageState;
  /** Every configuration approval the thread's Project holds. */
  readonly approvals: ReadonlyArray<DebugConfigurationApproval>;
  /**
   * Whether the configuration's program (a regular file) and folder still
   * resolve inside the checkout with symlinks followed, checked by the host
   * at this start.
   */
  readonly configurationPaths: "resolve" | "unresolved";
  /** The adapter's declared `debugPorts`. */
  readonly debugPorts: 0 | 1;
}

export interface DebugSessionLaunchShape {
  readonly confinement: "seatbelt" | "bubblewrap";
  /** The adapter launches the program as its own child in the same capsule. */
  readonly capsule: "adapter-and-program";
  readonly checkout: "read-write";
  /** The checkout, and a per-session state folder made fresh at every start. */
  readonly writes: "checkout-and-session-state";
  readonly execution: "confined-as-terminal";
  /**
   * The thread's own rules, decided as its harness commands are, below Full
   * access; the open network the person chose under it.
   */
  readonly network: "proxied-under-thread-rules" | "allow";
  /**
   * Linux keeps loopback between adapter and program inside the capsule's
   * private network namespace. macOS opens one host-chosen `localhost` port
   * and nothing else on loopback.
   */
  readonly debugPort: "none" | "inside-capsule-namespace" | "host-chosen-localhost-port";
}

export type DebugSessionStartRefusal = Extract<
  CodeDebugStartRefusalReason,
  | "unsupported-platform"
  | "mode-prohibited"
  | "plan-read-only"
  | "local-host-required"
  | "approval-required"
  | "configuration-invalid"
>;

export type DebugSessionStartDecision =
  | { readonly status: "launch"; readonly shape: DebugSessionLaunchShape }
  | { readonly status: "refused"; readonly reason: DebugSessionStartRefusal };

export function decideDebugSessionStart(
  request: DebugSessionStartRequest,
): DebugSessionStartDecision {
  if (request.platform !== "macos" && request.platform !== "linux") {
    return { status: "refused", reason: "unsupported-platform" };
  }
  // The component kind is Code only, and Chat and Work have no checkout a
  // session could run in.
  if (request.mode !== "code") return { status: "refused", reason: "mode-prohibited" };
  if (request.posture === "plan") return { status: "refused", reason: "plan-read-only" };
  // Starting runs the program on the host, which stays with the person at the
  // machine; an approval on record does not let a device or an agent start it.
  if (request.startedBy !== "local-window") {
    return { status: "refused", reason: "local-host-required" };
  }
  if (!request.approvals.some((approval) => approvalCovers(approval, request))) {
    return { status: "refused", reason: "approval-required" };
  }
  if (request.configurationPaths !== "resolve") {
    return { status: "refused", reason: "configuration-invalid" };
  }
  const linux = request.platform === "linux";
  return {
    status: "launch",
    shape: {
      confinement: linux ? "bubblewrap" : "seatbelt",
      capsule: "adapter-and-program",
      checkout: "read-write",
      writes: "checkout-and-session-state",
      execution: "confined-as-terminal",
      network: request.posture === "full-access" ? "allow" : "proxied-under-thread-rules",
      debugPort:
        request.debugPorts === 0
          ? "none"
          : linux
            ? "inside-capsule-namespace"
            : "host-chosen-localhost-port",
    },
  };
}

/**
 * An approval covers this start only for the configuration's current digest
 * and the adapter's current package state, in its checkout or its Project.
 * Any edit or package change leaves it covering a state that no longer
 * exists, so the person confirms again; nothing has to revoke it.
 */
function approvalCovers(
  approval: DebugConfigurationApproval,
  request: DebugSessionStartRequest,
): boolean {
  return (
    String(approval.configurationDigest) === String(request.configurationDigest) &&
    String(approval.adapter.extensionId) === String(request.adapter.extensionId) &&
    String(approval.adapter.componentId) === String(request.adapter.componentId) &&
    String(approval.adapter.packageDigest) === String(request.adapter.packageDigest) &&
    approval.adapter.lifecycleVersion === request.adapter.lifecycleVersion &&
    (approval.scope.kind === "project" ||
      String(approval.scope.checkoutId) === String(request.checkoutId))
  );
}
