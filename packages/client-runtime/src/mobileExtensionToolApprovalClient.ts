import {
  ExtensionToolApprovalList,
  decodeExtensionToolApprovalDecision,
} from "@octant/contracts/extension-rpc";
import { decodeHostAnswer } from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const TOOL_APPROVALS_PATH = "/api/extensions/tool-approvals";

/**
 * The MCP tool prompts this paired device's own turns raised in one thread.
 * The host lists only those, and only while the thread still stands in its
 * Project; an empty list is the answer whenever the host refuses.
 */
export async function listMobileExtensionToolApprovals(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}): Promise<ExtensionToolApprovalList> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: TOOL_APPROVALS_PATH,
    body: JSON.stringify({ kind: "list" }),
    contentType: "application/json",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) return [];
  const listed = decodeHostAnswer(ExtensionToolApprovalList)(await response.json());
  return listed.filter((approval) => String(approval.threadId) === input.threadId);
}

/**
 * Approves one call or denies it. A paired device never sends `remember`:
 * "always allow in this Project" is a local window's answer, and the host
 * refuses it from here.
 */
export async function decideMobileExtensionToolApproval(input: {
  readonly transport: MobileRemoteTransport;
  readonly approvalId: string;
  readonly decision: "approved" | "denied";
}): Promise<"accepted" | "refused"> {
  const decision = decodeExtensionToolApprovalDecision({
    approvalId: input.approvalId,
    decision: input.decision,
  });
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: TOOL_APPROVALS_PATH,
    body: JSON.stringify({ kind: "decide", ...decision }),
    contentType: "application/json",
  });
  if (!response.ok) return "refused";
  const body = (await response.json()) as { accepted?: unknown };
  return body.accepted === true ? "accepted" : "refused";
}
