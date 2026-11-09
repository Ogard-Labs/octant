import {
  decodeOwnerPostureTargets,
  decodeOwnerPostureChangeRequest,
  type OwnerPostureTarget,
  type OwnerPosture,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import { ownerActionNotice } from "./ownerAlerts";
import type { OwnerAdministrationClient, OwnerActionResult } from "./hubOwnerClient";

export const OWNER_POSTURE_LABELS: Readonly<Record<ProviderExecutionPolicy, string>> = {
  "approval-gated": "Ask first",
  "auto-accept-edits": "Accept folder edits",
  "full-access": "Full access",
  plan: "Plan (read only)",
};
export type OwnerPostureReading =
  | { readonly status: "read"; readonly targets: ReadonlyArray<OwnerPostureTarget> }
  | { readonly status: "problem"; readonly message: string };
export async function readOwnerPostures(
  client: Partial<Pick<OwnerAdministrationClient, "listPostures">>,
): Promise<OwnerPostureReading> {
  try {
    if (client.listPostures === undefined)
      return { status: "problem", message: "Access recovery is unavailable on this client." };
    const result = await client.listPostures();
    if (
      result.status === "done" &&
      typeof result.body === "object" &&
      result.body !== null &&
      "targets" in result.body
    ) {
      return { status: "read", targets: decodeOwnerPostureTargets(result.body.targets) };
    }
    return { status: "problem", message: ownerActionNotice(result, "").message };
  } catch {
    return { status: "problem", message: "Could not read access levels. Refresh to try again." };
  }
}
/** Uses only the authoritative reading the person selected; never retries a write. */
export async function changeOwnerPosture(
  client: Partial<Pick<OwnerAdministrationClient, "changePosture">>,
  before: OwnerPosture,
  posture: OwnerPosture["posture"],
): Promise<OwnerActionResult> {
  if (!ownerPostureLevels(before).includes(posture))
    return { status: "refused", kind: "unsupported" };
  try {
    if (client.changePosture === undefined) return { status: "refused", kind: "unsupported" };
    if (before.subject.kind === "work-thread") {
      return await client.changePosture(
        decodeOwnerPostureChangeRequest({
          subject: before.subject,
          expectedVersion: before.version,
          posture,
        }),
      );
    }
    return await client.changePosture(
      decodeOwnerPostureChangeRequest({
        subject: before.subject,
        expectedVersion: before.version,
        posture,
        persistence:
          posture === "full-access" || before.subject.kind === "project"
            ? posture === "full-access"
              ? "project-default"
              : "current-session"
            : (("persistence" in before ? before.persistence : undefined) ?? "current-session"),
      }),
    );
  } catch {
    return { status: "unreachable" };
  }
}

/** A reviewer stays as the thread chose it; changing posture does not grant one. */
export function ownerPostureLabel(posture: OwnerPosture, requested = posture.posture): string {
  if (posture.subject.kind === "project")
    return requested === "full-access" ? "Remember Full access" : "Do not remember Full access";
  if (requested === "ask-first") return "Ask first";
  if (requested === "auto") return "Auto";
  if ("autoApprove" in posture && posture.autoApprove === true && requested === "approval-gated")
    return "Auto";
  if ("autoApprove" in posture && posture.autoApprove === true && requested === "auto-accept-edits")
    return "Auto (accept folder edits)";
  return OWNER_POSTURE_LABELS[requested];
}

/** Work has its own Auto level and no Plan overlay or remembered Project default. */
export function ownerPostureLevels(
  posture: OwnerPosture | undefined,
): ReadonlyArray<OwnerPosture["posture"]> {
  return posture?.subject.kind === "work-thread"
    ? ["ask-first", "auto-accept-edits", "auto", "full-access"]
    : posture?.subject.kind === "project"
      ? ["approval-gated", "full-access"]
      : ["approval-gated", "auto-accept-edits", "plan", "full-access"];
}
