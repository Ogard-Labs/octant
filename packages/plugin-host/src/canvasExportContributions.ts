import type {
  CanvasExportContribution,
  CanvasExportImplementedFormat,
  CanvasExportTargetOffer,
  CanvasExportTargetStatus,
} from "@octant/contracts/canvas-export";
import { isCanvasExportImplementedFormat } from "@octant/contracts/canvas-export";
import type { ExtensionEffectiveState } from "@octant/contracts/extensions";

/**
 * Trust and connection facts for one export destination. These are the
 * effective facts the activation pipeline already resolved. This policy only
 * decides whether the destination may be offered, and with what status.
 */
export interface CanvasExportActivationFacts {
  readonly installed: boolean;
  readonly trusted: boolean;
  readonly desiredEnabled: boolean;
  readonly effectiveState: ExtensionEffectiveState;
  readonly connected: boolean;
  /** A connected destination that will not accept an export. */
  readonly standingRefusal?: string;
}

export interface AdmitCanvasExportContributionInput {
  readonly contribution: CanvasExportContribution;
  readonly facts: CanvasExportActivationFacts;
}

export type CanvasExportAdmission =
  | {
      readonly kind: "omitted";
      readonly reason: "not-installed" | "disabled" | "untrusted" | "not-effective" | "duplicate";
    }
  | { readonly kind: "offered"; readonly offer: CanvasExportTargetOffer };

const NOT_CONNECTED = "This destination is not connected.";
const LATER_FORMAT = "This destination does not accept a format this host can render.";

function implementedFormats(
  contribution: CanvasExportContribution,
): ReadonlyArray<CanvasExportImplementedFormat> {
  const formats: CanvasExportImplementedFormat[] = [];
  for (const format of contribution.formats) {
    if (isCanvasExportImplementedFormat(format) && !formats.includes(format)) {
      formats.push(format);
    }
  }
  return formats;
}

/**
 * Decide whether a destination may appear in an export offer.
 *
 * A disabled or uninstalled target is omitted. Installation, selection, and a
 * declared contribution never satisfy the gates on their own. A target that
 * passes activation is still listed with an honest status when it is not
 * connected or has refused.
 */
export function admitCanvasExportContribution(
  input: AdmitCanvasExportContributionInput,
): CanvasExportAdmission {
  const { contribution, facts } = input;
  if (!facts.installed) {
    return { kind: "omitted", reason: "not-installed" };
  }
  if (!facts.trusted) {
    return { kind: "omitted", reason: "untrusted" };
  }
  if (!facts.desiredEnabled) {
    return { kind: "omitted", reason: "disabled" };
  }
  if (facts.effectiveState.kind !== "effective") {
    return { kind: "omitted", reason: "not-effective" };
  }

  const formats = implementedFormats(contribution);
  const standing = facts.standingRefusal?.trim();
  let status: CanvasExportTargetStatus = "ready";
  let message: string | undefined;
  if (standing !== undefined && standing.length > 0) {
    status = "refused";
    message = standing;
  } else if (!facts.connected) {
    status = "not-connected";
    message = NOT_CONNECTED;
  } else if (formats.length === 0) {
    status = "refused";
    message = LATER_FORMAT;
  }

  return {
    kind: "offered",
    offer: {
      targetId: contribution.targetId,
      label: contribution.label,
      formats,
      status,
      ...(message === undefined ? {} : { message }),
    },
  };
}

/**
 * Destinations a person may see. Omitted candidates are absent, not listed as
 * refused. The first admitted target id wins so a later contribution cannot
 * replace it.
 */
export function offerCanvasExportTargets(
  candidates: ReadonlyArray<AdmitCanvasExportContributionInput>,
): ReadonlyArray<CanvasExportTargetOffer> {
  const offered: CanvasExportTargetOffer[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(String(candidate.contribution.targetId))) continue;
    const admission = admitCanvasExportContribution(candidate);
    if (admission.kind !== "offered") continue;
    seen.add(String(admission.offer.targetId));
    offered.push(admission.offer);
  }
  return offered;
}
