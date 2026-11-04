import {
  decodeOwnerPostureTargets,
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
      return { status: "problem", message: "Code recovery is unavailable on this client." };
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
    return { status: "problem", message: "Could not read Code levels. Refresh to try again." };
  }
}
/** Uses only the authoritative reading the person selected; never retries a write. */
export async function changeOwnerPosture(
  client: Partial<Pick<OwnerAdministrationClient, "changePosture">>,
  before: OwnerPosture,
  posture: ProviderExecutionPolicy,
): Promise<OwnerActionResult> {
  try {
    if (client.changePosture === undefined) return { status: "refused", kind: "unsupported" };
    return await client.changePosture({
      subject: before.subject,
      expectedVersion: before.version,
      posture,
      persistence:
        posture === "full-access" || before.subject.kind === "project"
          ? posture === "full-access"
            ? "project-default"
            : "current-session"
          : (before.persistence ?? "current-session"),
    });
  } catch {
    return { status: "unreachable" };
  }
}

/** A reviewer stays as the thread chose it; changing posture does not grant one. */
export function ownerPostureLabel(posture: OwnerPosture, requested = posture.posture): string {
  if (posture.subject.kind === "project")
    return requested === "full-access" ? "Remember Full access" : "Do not remember Full access";
  if (posture.autoApprove === true && requested === "approval-gated") return "Auto";
  if (posture.autoApprove === true && requested === "auto-accept-edits")
    return "Auto (accept folder edits)";
  return OWNER_POSTURE_LABELS[requested];
}
