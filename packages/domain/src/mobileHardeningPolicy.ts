/**
 * Pure Mobile D hardening policy. Presentation and fail-soft decisions only —
 * hosts remain authoritative for mutation admission.
 */

export const MOBILE_REMOTE_CONTROL_THREAT_MODEL_ID = "mobile-remote-control-v1" as const;

export type DeviceIntegritySignal = "unknown" | "nominal" | "suspicious";

export type DeviceIntegrityPresentation = {
  readonly signal: DeviceIntegritySignal;
  readonly severity: "none" | "soft-warn";
  readonly message: string;
  /** Never blocks pairing or reads; revoke remains available. */
  readonly blocksMutations: false;
};

export type ScreenshotPrivacyMode = "standard" | "hide-in-recents";

export type ScreenshotPrivacyDecision = {
  readonly mode: ScreenshotPrivacyMode;
  readonly preferNativeCaptureBlock: boolean;
  readonly blurInAppSwitcher: boolean;
  readonly summary: string;
};

export type HostSessionHealthKind =
  | "idle"
  | "connecting"
  | "ready"
  | "stale"
  | "unavailable"
  | "unauthorized"
  | "incompatible";

export type StaleHostSecurityPresentation = {
  readonly health: HostSessionHealthKind;
  readonly allowProductMutations: boolean;
  readonly message: string;
};

const SECRETISH =
  /\b(sk-|ghp_|github_pat_|-----BEGIN|password|api[_-]?key|authorization|bearer)\b/i;
const ABSOLUTE_PATH = /(?:^|[\s"'`])(?:\/(?:Users|home|private|var|tmp|etc)\/|\w:\\)/;

/**
 * Map a coarse integrity heuristic to fail-soft presentation. Suspicious never
 * bricks the app; the user can still revoke and re-pair.
 */
export function evaluateDeviceIntegrityHeuristic(
  signal: DeviceIntegritySignal,
): DeviceIntegrityPresentation {
  if (signal === "suspicious") {
    return {
      signal,
      severity: "soft-warn",
      message:
        "This phone may be jailbroken or rooted. Treat it as higher risk and revoke from Hosts if it is not yours.",
      blocksMutations: false,
    };
  }
  if (signal === "nominal") {
    return {
      signal,
      severity: "none",
      message: "No elevated integrity risk was reported for this phone.",
      blocksMutations: false,
    };
  }
  return {
    signal: "unknown",
    severity: "none",
    message: "Device integrity checks are unavailable on this build.",
    blocksMutations: false,
  };
}

export function decideScreenshotPrivacyMode(
  mode: ScreenshotPrivacyMode,
): ScreenshotPrivacyDecision {
  if (mode === "hide-in-recents") {
    return {
      mode,
      preferNativeCaptureBlock: true,
      blurInAppSwitcher: true,
      summary: "Hide Octant content in recents and prefer native screen-capture blocking.",
    };
  }
  return {
    mode: "standard",
    preferNativeCaptureBlock: false,
    blurInAppSwitcher: false,
    summary: "Standard screen capture. Enable hide-in-recents for travel or shared devices.",
  };
}

export function presentStaleHostSecurity(
  health: HostSessionHealthKind,
): StaleHostSecurityPresentation {
  if (health === "ready") {
    return {
      health,
      allowProductMutations: true,
      message: "Host is ready. Product mutations follow ordinary host policy and biometric gates.",
    };
  }
  if (health === "stale") {
    return {
      health,
      allowProductMutations: false,
      message: "Host session is stale. Reads only — reconnect before mutating.",
    };
  }
  if (health === "unavailable") {
    return {
      health,
      allowProductMutations: false,
      message: "Host is unavailable. No product mutations are queued from this phone.",
    };
  }
  if (health === "unauthorized") {
    return {
      health,
      allowProductMutations: false,
      message: "Host rejected this phone’s session. Re-pair or revoke before mutating.",
    };
  }
  if (health === "incompatible") {
    return {
      health,
      allowProductMutations: false,
      message: "Host protocol is incompatible with this app build.",
    };
  }
  if (health === "connecting") {
    return {
      health,
      allowProductMutations: false,
      message: "Still connecting. Wait until the host is ready before mutating.",
    };
  }
  return {
    health: "idle",
    allowProductMutations: false,
    message: "Host is idle. Pair or resume a session before mutating.",
  };
}

/** Scrub UI / recents strings so secrets and absolute paths never linger. */
export function scrubScreenshotSafeCopy(value: string, maxLength = 160): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return "";
  if (SECRETISH.test(trimmed) || ABSOLUTE_PATH.test(trimmed)) {
    return "Details available on the host.";
  }
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function isScreenshotSafeSurfaceCopy(value: string): boolean {
  return !SECRETISH.test(value) && !ABSOLUTE_PATH.test(value);
}
