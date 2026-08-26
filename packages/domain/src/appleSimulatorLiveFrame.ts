import type { AppleBuildEvidence, AppleSimulatorId, AppleSimulatorRecord } from "@octant/contracts";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts";

export const APPLE_HOST_RESTART_RECONCILIATION_NOTE =
  "Apple action was interrupted by a host restart and reconciled without claiming success.";

export type AppleSimulatorLiveFrameAttach =
  | { readonly kind: "attachable" }
  | { readonly kind: "not-attachable"; readonly reason: string };

export type AppleSimulatorLiveScreen =
  | { readonly kind: "screenshot"; readonly reference: string }
  | { readonly kind: "pending" };

export type AppleSimulatorLiveFrameUnavailableReason =
  | "toolchain-missing"
  | "no-destination"
  | "not-attachable"
  | "thread-mismatch";

export type AppleSimulatorLiveFrame =
  | {
      readonly status: "setup";
      readonly title: string;
      readonly message: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: AppleSimulatorLiveFrameUnavailableReason;
      readonly title: string;
      readonly message: string;
    }
  | {
      readonly status: "booting";
      readonly simulatorId: AppleSimulatorId;
      readonly name: string;
      readonly title: string;
      readonly message: string;
    }
  | {
      readonly status: "live";
      readonly simulatorId: AppleSimulatorId;
      readonly name: string;
      readonly screen: AppleSimulatorLiveScreen;
      readonly title: string;
      readonly message: string;
    }
  | {
      readonly status: "interrupted";
      readonly title: string;
      readonly message: string;
    }
  | {
      readonly status: "stale-after-restart";
      readonly simulatorId?: AppleSimulatorId;
      readonly name?: string;
      readonly lastScreen?: { readonly reference: string };
      readonly title: string;
      readonly message: string;
    };

export interface AppleSimulatorLiveFrameInput {
  readonly discovering: boolean;
  readonly interrupted: boolean;
  readonly toolchainAvailable: boolean;
  readonly frameAttach: AppleSimulatorLiveFrameAttach;
  readonly simulators: ReadonlyArray<AppleSimulatorRecord>;
  readonly boundThreadId: CodeThreadId;
  readonly boundCheckoutId: CodeCheckoutId;
  readonly visibleThreadId: CodeThreadId;
  readonly visibleCheckoutId: CodeCheckoutId;
  readonly restartReconciled: boolean;
  readonly latestScreenshot?: {
    readonly simulatorId?: AppleSimulatorId;
    readonly reference: string;
  };
}

export function isAppleHostRestartReconciliation(evidence: AppleBuildEvidence): boolean {
  return (
    evidence.outcome === "interrupted" &&
    evidence.diagnostics.some(
      (diagnostic) => diagnostic.message === APPLE_HOST_RESTART_RECONCILIATION_NOTE,
    )
  );
}

export function appleLiveFrameIsStaleAfterRestart(
  evidence: ReadonlyArray<AppleBuildEvidence>,
): boolean {
  let lastRestartAt: string | undefined;
  let lastVerifiedScreenAt: string | undefined;
  for (const item of evidence) {
    if (isAppleHostRestartReconciliation(item)) lastRestartAt = item.completedAt;
    if (item.kind === "screenshot" && item.outcome === "succeeded") {
      lastVerifiedScreenAt = item.completedAt;
    }
  }
  if (lastRestartAt === undefined) return false;
  return lastVerifiedScreenAt === undefined || lastVerifiedScreenAt <= lastRestartAt;
}

export function latestAppleScreenshotEvidence(evidence: ReadonlyArray<AppleBuildEvidence>):
  | {
      readonly simulatorId?: AppleSimulatorId;
      readonly reference: string;
      readonly completedAt: string;
    }
  | undefined {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const item = evidence[index];
    if (item === undefined || item.kind !== "screenshot" || item.outcome !== "succeeded") continue;
    const screenshot = item.artifacts.find((artifact) => artifact.kind === "screenshot");
    if (screenshot === undefined) continue;
    return {
      ...(item.simulatorId === undefined ? {} : { simulatorId: item.simulatorId }),
      reference: screenshot.reference,
      completedAt: item.completedAt,
    };
  }
  return undefined;
}

export function presentAppleSimulatorLiveFrame(
  input: AppleSimulatorLiveFrameInput,
): AppleSimulatorLiveFrame {
  if (input.discovering) {
    return {
      status: "setup",
      title: "Setting up Simulator",
      message: "Discovering Xcode and Simulator destinations for this Code thread.",
    };
  }
  if (
    String(input.visibleThreadId) !== String(input.boundThreadId) ||
    String(input.visibleCheckoutId) !== String(input.boundCheckoutId)
  ) {
    return {
      status: "unavailable",
      reason: "thread-mismatch",
      title: "Simulator belongs to another thread",
      message: "This live frame is bound to a different Code thread and checkout.",
    };
  }
  const destination = selectLiveDestination(input.simulators, input.latestScreenshot);
  if (input.restartReconciled) {
    return {
      status: "stale-after-restart",
      ...(destination === undefined
        ? {}
        : { simulatorId: destination.simulatorId, name: destination.name }),
      ...(input.latestScreenshot === undefined
        ? {}
        : { lastScreen: { reference: input.latestScreenshot.reference } }),
      title: "Simulator is stale after restart",
      message:
        "Ownership was reconciled after a host restart. This is not a live frame until the destination is observed again.",
    };
  }
  if (input.interrupted) {
    return {
      status: "interrupted",
      title: "Simulator frame interrupted",
      message: "The owned process stopped before a verified live frame was recorded.",
    };
  }
  if (!input.toolchainAvailable) {
    return {
      status: "unavailable",
      reason: "toolchain-missing",
      title: "Simulator is unavailable",
      message:
        "Install or select Xcode and an iOS Simulator runtime on the Mac that owns this Code thread, then retry.",
    };
  }
  if (destination?.state === "booting") {
    return {
      status: "booting",
      simulatorId: destination.simulatorId,
      name: destination.name,
      title: "Simulator is booting",
      message: `Waiting for ${destination.name} to become ready.`,
    };
  }
  if (input.frameAttach.kind === "not-attachable") {
    return {
      status: "unavailable",
      reason: "not-attachable",
      title: "Simulator frame is not attachable",
      message: input.frameAttach.reason,
    };
  }
  if (destination?.state === "booted") {
    const screenFromDestination =
      input.latestScreenshot !== undefined &&
      (input.latestScreenshot.simulatorId === undefined ||
        String(input.latestScreenshot.simulatorId) === String(destination.simulatorId))
        ? input.latestScreenshot
        : undefined;
    return {
      status: "live",
      simulatorId: destination.simulatorId,
      name: destination.name,
      screen:
        screenFromDestination === undefined
          ? { kind: "pending" }
          : { kind: "screenshot", reference: screenFromDestination.reference },
      title: `Live · ${destination.name}`,
      message:
        screenFromDestination === undefined
          ? "The destination is live. Capture the screen to show host-held evidence in this frame."
          : "Showing the latest host-held screen capture for this thread. This is not a video stream.",
    };
  }
  return {
    status: "unavailable",
    reason: "no-destination",
    title: "Simulator is unavailable",
    message: "Boot a Simulator destination for this Code thread to open a live frame.",
  };
}

function selectLiveDestination(
  simulators: ReadonlyArray<AppleSimulatorRecord>,
  latestScreenshot: AppleSimulatorLiveFrameInput["latestScreenshot"],
): AppleSimulatorRecord | undefined {
  if (latestScreenshot?.simulatorId !== undefined) {
    const matched = simulators.find(
      (candidate) => candidate.simulatorId === latestScreenshot.simulatorId,
    );
    if (matched !== undefined) return matched;
  }
  return (
    simulators.find((candidate) => candidate.state === "booting") ??
    simulators.find((candidate) => candidate.state === "booted") ??
    simulators.find((candidate) => candidate.state !== "unavailable")
  );
}
