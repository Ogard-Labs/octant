import { randomUUID } from "node:crypto";
import { decodeBrowserToolApprovalList, type OctantMode } from "@octant/contracts";
import { decodePendingRequestList } from "@octant/contracts/pending-requests";
import { refusalMessage, type HostRefusal } from "./agentHost";
import type { OpenedLocalControlSession } from "./localControl";

/**
 * A Browser call parked until someone allows the site it wants to open.
 *
 * These asks are not harness approvals, so the harness session never lists
 * them: a Work turn's ask lives with the host's Browser approvals and a Code
 * turn's ask is an approval on the turn's own operation. The terminal reads
 * and answers each one through the same route the app's thread view uses, so
 * the host's window and thread checks decide it exactly as they would there.
 */
export type AgentSiteApproval =
  | {
      readonly mode: "work";
      readonly id: string;
      readonly threadId: string;
      readonly origin: string;
    }
  | {
      readonly mode: "code";
      readonly id: string;
      readonly threadId: string;
      readonly origin: string;
      readonly checkoutId: string;
    };

export type SiteApprovalOutcome =
  | { readonly kind: "answered"; readonly decision: "approved" | "denied" }
  | HostRefusal;

/**
 * The site asks this thread's running turn is waiting on. Chat has no Browser,
 * so it never has one.
 *
 * A Code turn's pending approvals also include a provider's own tool
 * approvals, which can be far more powerful than opening a site. Only an
 * entry the host marks with the site it waits on is a site ask; the rest are
 * never offered as one.
 */
export async function listAgentSiteApprovals(
  session: OpenedLocalControlSession,
  mode: OctantMode,
  threadId: string,
): Promise<ReadonlyArray<AgentSiteApproval>> {
  if (mode === "work") {
    const response = await session.send({
      path: "/api/browser/approvals",
      method: "POST",
      body: { kind: "list" },
    });
    if (response.status !== 200) return [];
    return decodeBrowserToolApprovalList(response.body)
      .filter((approval) => String(approval.threadId) === threadId)
      .map((approval) => ({
        mode: "work" as const,
        id: String(approval.approvalId),
        threadId,
        origin: approval.origin,
      }));
  }
  if (mode === "code") {
    const response = await session.send({ path: "/api/pending-requests", method: "GET" });
    if (response.status !== 200) return [];
    return decodePendingRequestList(response.body).requests.flatMap((request) =>
      request.mode === "code" &&
      request.kind === "approval" &&
      request.browserOrigin !== undefined &&
      String(request.threadId) === threadId
        ? [
            {
              mode: "code" as const,
              id: String(request.answer.approvalId),
              threadId,
              origin: request.browserOrigin,
              checkoutId: String(request.answer.checkoutId),
            },
          ]
        : [],
    );
  }
  return [];
}

/**
 * Asks the person about one site and sends their answer: y allows once, a
 * (Work only) also remembers the site the way the app's "Always allow" does,
 * and anything else denies. JSON mode emits the ask as a line and reads the
 * answer the same way, as it does for harness approvals.
 *
 * When stdin has ended there is no one left to ask. The call is denied, and
 * the Browser tool returns the denial to the model as its named failure, so
 * the turn moves on instead of waiting out the host's expiry.
 */
export async function askSiteApproval(input: {
  readonly session: OpenedLocalControlSession;
  readonly approval: AgentSiteApproval;
  readonly json: boolean;
  readonly readLine: () => Promise<string | undefined>;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}): Promise<SiteApprovalOutcome> {
  const { approval } = input;
  const canRemember = approval.mode === "work";
  if (input.json) {
    input.stdout.write(
      `${JSON.stringify({ kind: "site-approval", approval: { ...approval, canRemember } })}\n`,
    );
  } else {
    input.stdout.write(
      `\n! Browser wants to open ${approval.origin}\n  allow? [y]es / ${canRemember ? "[a]lways this site / " : ""}[n]o > `,
    );
  }
  const line = await input.readLine();
  if (line === undefined) {
    input.stderr.write(
      "No answer came from this terminal, so the Browser call was refused (browser-approval-denied).\n",
    );
  }
  const answer = line?.trim().toLowerCase() ?? "";
  const allow = answer === "y" || answer === "yes" || answer === "approve";
  const always = canRemember && (answer === "a" || answer === "always");
  const decision = allow || always ? "approved" : "denied";
  return await decideSiteApproval(input.session, approval, decision, always);
}

/** Sends one answer through the route the app's thread view uses for this mode. */
export async function decideSiteApproval(
  session: OpenedLocalControlSession,
  approval: AgentSiteApproval,
  decision: "approved" | "denied",
  remember = false,
): Promise<SiteApprovalOutcome> {
  if (approval.mode === "work") {
    const response = await session.send({
      path: "/api/browser/approvals",
      method: "POST",
      body: {
        kind: "decide",
        approvalId: approval.id,
        decision,
        ...(remember && decision === "approved" ? { remember: true } : {}),
      },
    });
    // 409 is the host saying the ask already ended: answered elsewhere,
    // expired, or the turn stopped.
    if (response.status !== 200) {
      return {
        kind: "refused",
        message: refusalMessage(response, "That site ask has already ended."),
      };
    }
    return { kind: "answered", decision };
  }
  const response = await session.send({
    path: "/api/code/commands",
    method: "POST",
    body: {
      kind: "answer-provider-approval",
      operationId: randomUUID(),
      threadId: approval.threadId,
      checkoutId: approval.checkoutId,
      approvalId: approval.id,
      decision,
    },
  });
  const refused =
    response.status !== 200
      ? refusalMessage(response, "The answer was not delivered.")
      : codeAnswerRefusal(response.body);
  return refused === undefined
    ? { kind: "answered", decision }
    : { kind: "refused", message: refused };
}

/**
 * Why the host did not take a Code answer, or undefined when it did. The
 * command answers 200 either way; a turn that changed since it asked comes
 * back failed, and one stopped by the answer names its reason.
 */
function codeAnswerRefusal(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const result = body as {
    readonly kind?: unknown;
    readonly state?: unknown;
    readonly failure?: { readonly message?: unknown };
  };
  const refused =
    result.kind === "operation-failed" ||
    (result.kind === "provider-turn-state" &&
      (result.state === "failed" ||
        (result.state === "interrupted" && result.failure !== undefined)));
  if (!refused) return undefined;
  const message = result.failure?.message;
  return typeof message === "string" && message.length > 0
    ? message
    : "The answer was not delivered. The turn changed since it asked.";
}
