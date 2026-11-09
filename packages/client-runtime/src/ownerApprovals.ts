import {
  decodeOwnerApprovalAnswer,
  decodeOwnerApprovalReading,
  type OwnerApprovalReading,
  type OwnerApprovalTarget,
} from "@octant/contracts/owner-approvals";
import type { OwnerActionResult, OwnerAdministrationClient } from "./hubOwnerClient";
import { ownerActionNotice } from "./ownerAlerts";

export async function readOwnerApprovals(
  client: Partial<Pick<OwnerAdministrationClient, "readApprovals">>,
): Promise<
  | { readonly status: "read"; readonly reading: OwnerApprovalReading }
  | { readonly status: "problem"; readonly message: string }
> {
  if (client.readApprovals === undefined)
    return { status: "problem", message: "Approval recovery is unavailable on this client." };
  try {
    const result = await client.readApprovals();
    return result.status === "done"
      ? { status: "read", reading: decodeOwnerApprovalReading(result.body) }
      : { status: "problem", message: ownerActionNotice(result, "").message };
  } catch {
    return { status: "problem", message: "Could not read approvals. Refresh to try again." };
  }
}

/** Sends only the exact consent digests and answer, never the private action body. No fallback or retry. */
export async function answerOwnerApproval(
  client: Partial<Pick<OwnerAdministrationClient, "answerApproval">>,
  target: OwnerApprovalTarget,
  approved: boolean,
): Promise<OwnerActionResult> {
  if (client.answerApproval === undefined) return { status: "refused", kind: "unsupported" };
  try {
    const result = await client.answerApproval(
      decodeOwnerApprovalAnswer({
        ownerMemberId: target.ownerMemberId,
        hostMemberId: target.hostMemberId,
        mode: target.mode,
        threadId: target.threadId,
        projectId: target.projectId,
        requestId: target.requestId,
        targetVersion: target.targetVersion,
        actionDigest: target.actionDigest,
        approved,
      }),
    );
    if (
      result.status === "done" &&
      (typeof result.body !== "object" ||
        result.body === null ||
        !("status" in result.body) ||
        (result.body.status !== "delivered" && result.body.status !== "uncertain"))
    )
      return { status: "refused", kind: "invalid-answer" };
    return result;
  } catch {
    return { status: "unreachable" };
  }
}
