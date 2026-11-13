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
 * Project. A refused read throws, so a caller can tell "nothing is waiting"
 * (an empty list) from "could not ask" and keep what it last showed.
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
  if (!response.ok) throw new Error(`Listing tool approvals failed with ${response.status}.`);
  const listed = decodeHostAnswer(ExtensionToolApprovalList)(await response.json());
  return listed.filter((approval) => String(approval.threadId) === input.threadId);
}

/**
 * Approves or denies. What an approval covers is the host's to say on the
 * prompt (`answerCovers`); `remember` only narrows a whole-server approval
 * to this one tool, where the prompt offers that.
 */
export async function decideMobileExtensionToolApproval(input: {
  readonly transport: MobileRemoteTransport;
  readonly approvalId: string;
  readonly decision: "approved" | "denied";
  readonly remember?: boolean;
}): Promise<"accepted" | "refused"> {
  const decision = decodeExtensionToolApprovalDecision({
    approvalId: input.approvalId,
    decision: input.decision,
    ...(input.remember === true ? { remember: true } : {}),
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
