import {
  decodeToolEgressCommand,
  type ToolEgressCommand,
  type ToolEgressCommandRefusalReason,
  type ToolEgressCommandResult,
} from "@octant/contracts";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type {
  ToolEgressAnswerOutcome,
  ToolEgressPerson,
  ToolEgressRules,
} from "./nativeHarnessEgressRules";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const PREFIX = "/api/native-harness/egress/threads/";

export interface NativeHarnessEgressRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly rules: Pick<ToolEgressRules, "view" | "answer" | "decline" | "revoke" | "setLearnMode">;
  /**
   * Whether this caller may answer the thread's approvals: the same check
   * the harness session's approvals use. A local window passes only for a
   * thread its workspace holds, which is what a Project rule also needs.
   */
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) => boolean | Promise<boolean>;
  readonly now?: () => number;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

/**
 * A Code thread's `network-access` surface: its rules, its Project's rules,
 * and its open learn-mode proposals, and a person's answers to them. The
 * principal comes from the authenticated request, never from the body; a
 * paired device keeps the clamps it has for the thread's approvals and may
 * never grant a Project rule.
 */
export function createNativeHarnessEgressRouteHandler(
  dependencies: NativeHarnessEgressRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Tool egress requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let body: unknown;
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        return failure("Tool egress body must be valid JSON.", 400, origin);
      }
    }
    let person: ToolEgressPerson;
    let windowId: string;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
        ...(body === undefined ? {} : { body }),
      });
      windowId = String(context.scopeId);
      person =
        context.principal.kind === "remote-device"
          ? { kind: "remote-device", deviceId: String(context.principal.deviceId) }
          : { kind: "local-window" };
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Tool egress request is unauthorized.", 401, origin);
      }
      return failure("Tool egress request is invalid.", 400, origin);
    }
    let threadId: string;
    try {
      threadId = decodeURIComponent(url.pathname.slice(PREFIX.length));
    } catch {
      return failure("Thread id is invalid.", 400, origin);
    }
    if (threadId.length === 0 || threadId.includes("/")) {
      return failure("Thread id is required.", 400, origin);
    }
    if (!(await dependencies.authorizeThread({ threadId, windowId }))) {
      return failure("Tool egress request is unauthorized.", 403, origin);
    }

    if (request.method === "GET") {
      return json({ view: dependencies.rules.view(threadId, person.kind) ?? null }, 200, origin);
    }
    if (request.method !== "POST") return failure("Method not allowed.", 405, origin);
    let command: ToolEgressCommand;
    try {
      command = decodeToolEgressCommand(body);
    } catch {
      return failure("Tool egress command is invalid.", 400, origin);
    }
    const outcome = run(dependencies.rules, threadId, person, command);
    const view = dependencies.rules.view(threadId, person.kind);
    const result: ToolEgressCommandResult =
      outcome.kind === "answered" && view !== undefined
        ? { kind: "tool-egress-updated", view }
        : refused(outcome.kind === "refused" ? outcome.reason : "not-a-code-thread");
    return json(result, result.kind === "tool-egress-updated" ? 200 : 409, origin);
  };
}

function run(
  rules: NativeHarnessEgressRouteDependencies["rules"],
  threadId: string,
  principal: ToolEgressPerson,
  command: ToolEgressCommand,
): ToolEgressAnswerOutcome {
  switch (command.kind) {
    case "grant-rules":
      return rules.answer({
        threadId,
        principal,
        grants: command.grants.map((grant) => ({
          host: grant.host,
          port: grant.port,
          scope: grant.choice,
        })),
        declineProposalIds: command.declineProposalIds.map(String),
      });
    case "decline-proposals":
      return rules.decline({ threadId, principal, proposalIds: command.proposalIds.map(String) });
    case "revoke-rule":
      return rules.revoke({ threadId, principal, ruleId: String(command.ruleId) });
    case "set-learn-mode":
      return rules.setLearnMode({ threadId, principal, enabled: command.enabled });
  }
}

const MESSAGES: Readonly<Record<ToolEgressCommandRefusalReason, string>> = {
  "not-a-code-thread": "Network rules belong to Code threads.",
  "thread-tainted":
    "This thread has read outside content, so a host can be allowed only for one command you confirm.",
  "needs-local-window": "A Project rule needs you at this computer.",
  "invalid-host":
    "That host cannot be a rule. Use a name such as registry.npmjs.org or *.example.com.",
  limit: "This thread or Project already holds the most rules it may.",
  "rule-not-found": "That rule is gone already.",
  "proposal-not-found": "Those hosts were already answered.",
  unavailable: "The answer could not be recorded, so nothing changed that is not listed.",
};

function refused(
  reason: Extract<ToolEgressAnswerOutcome, { kind: "refused" }>["reason"],
): ToolEgressCommandResult {
  // A person's answer never reaches the reviewer's refusals; they map to the
  // nearest thing a person could be told.
  const wire: ToolEgressCommandRefusalReason =
    reason === "needs-person"
      ? "thread-tainted"
      : reason === "reviewer-call-only"
        ? "needs-local-window"
        : reason;
  return { kind: "tool-egress-refused", reason: wire, message: MESSAGES[wire] };
}
