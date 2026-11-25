import {
  BrowserToolApprovalList,
  decodeBrowserToolApprovalDecision,
  type BrowserToolApproval,
  type BrowserToolApprovalDecision,
} from "@octant/contracts/browser-automation-rpc";
import { decodeHostAnswer } from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const BROWSER_APPROVALS_PATH = "/api/browser/approvals";

/**
 * The Browser approvals this paired device may see and answer for one thread:
 * a site, an upload, a download, a sign-in, a script or a page's tool, as
 * the host lists them for this session. A refused read throws, so a caller can
 * tell "nothing is waiting" (an empty list) from "could not ask" and keep what
 * it last showed.
 */
export async function listMobileBrowserApprovals(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<BrowserToolApproval>> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: BROWSER_APPROVALS_PATH,
    body: JSON.stringify({ kind: "list" }),
    contentType: "application/json",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new Error(`Listing Browser approvals failed with ${response.status}.`);
  const listed = decodeHostAnswer(BrowserToolApprovalList)(await response.json());
  return listed.filter((approval) => String(approval.threadId) === input.threadId);
}

/**
 * What the host said of an answer: taken, no longer open (answered first by
 * another window or device, or expired, or the thread no longer stands), or
 * refused for this session. The first answer settles an approval.
 */
export type MobileBrowserApprovalOutcome = "accepted" | "settled-elsewhere" | "refused";

export async function decideMobileBrowserApproval(input: {
  readonly transport: MobileRemoteTransport;
  readonly decision: BrowserToolApprovalDecision;
}): Promise<MobileBrowserApprovalOutcome> {
  const decision = decodeBrowserToolApprovalDecision(input.decision);
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: BROWSER_APPROVALS_PATH,
    body: JSON.stringify({ kind: "decide", ...decision }),
    contentType: "application/json",
  });
  // The host answers 409 `{ accepted: false }` for a prompt that was answered
  // first elsewhere, ran out, or can no longer be answered here.
  if (response.status === 409) return "settled-elsewhere";
  if (!response.ok) return "refused";
  const body: unknown = await response.json().catch(() => undefined);
  return typeof body === "object" &&
    body !== null &&
    (body as { accepted?: unknown }).accepted === true
    ? "accepted"
    : "settled-elsewhere";
}
