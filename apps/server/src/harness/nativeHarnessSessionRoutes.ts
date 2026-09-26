import {
  decodeAnswerNativeHarnessQuestion,
  decodeDecideNativeHarnessApproval,
  decodeSteerNativeHarnessSession,
  type NativeHarnessApprovalDecisionResult,
  type SteerNativeHarnessSession,
  decodeNativeHarnessSessionCommand,
  type NativeHarnessQuestionAnswerResult,
  type NativeHarnessSessionCommandResult,
} from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  settleFollowUpSuggestion,
  type FollowUpSuggestionActionDependencies,
} from "../followUps/followUpSuggestionRoutes";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const PREFIX = "/api/native-harness/sessions/";

export interface NativeHarnessSessionRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly store: Pick<NativeHarnessSessionStore, "read" | "pause" | "resume">;
  /** The thread's follow-up suggestions, which the session view shows but does not own. */
  readonly followUps: FollowUpSuggestionActionDependencies;
  /** Whether this window may read and steer the thread; never a body field. */
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) => boolean | Promise<boolean>;
  readonly interruptTurn?: (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) => void;
  readonly decideApproval?: (input: {
    readonly threadId: string;
    readonly approvalId: string;
    readonly decision: "approve" | "approve-always" | "deny";
  }) => "decided" | "approval-not-found" | "already-settled";
  readonly steer?: (input: {
    readonly threadId: string;
    readonly command: SteerNativeHarnessSession;
  }) => boolean;
  /** Settles a pending question from any surface; the outcome says why it could not. */
  readonly answerQuestion?: (input: {
    readonly threadId: string;
    readonly questionId: string;
    readonly answer: string;
  }) => "answered" | "question-not-found" | "already-settled";
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
 * The harness session as every surface reads it, plus what a person may do to
 * it: pause or resume the run, answer, approve, steer, and take a suggested
 * follow-up. Follow-ups are the thread's on every provider; this route keeps
 * offering them at their old address for surfaces that read the session.
 */

export function createNativeHarnessSessionRouteHandler(
  dependencies: NativeHarnessSessionRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Native harness session requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let windowId: string;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Native harness session request is unauthorized.", 401, origin);
      }
      return failure("Native harness session request is invalid.", 400, origin);
    }
    const [threadId = "", action = ""] = url.pathname.slice(PREFIX.length).split("/");
    if (threadId.length === 0) return failure("Thread id is required.", 400, origin);
    if (!(await dependencies.authorizeThread({ threadId, windowId }))) {
      return failure("Native harness session request is unauthorized.", 403, origin);
    }
    const view = dependencies.store.read(threadId);

    if (request.method === "GET" && action === "") {
      return view === undefined ? json({ view: null }, 200, origin) : json({ view }, 200, origin);
    }
    if (request.method !== "POST") return failure("Method not allowed.", 405, origin);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure("Native harness session body must be valid JSON.", 400, origin);
    }

    if (action === "commands") {
      let command;
      try {
        command = decodeNativeHarnessSessionCommand(body);
      } catch {
        return failure("Native harness session command is invalid.", 400, origin);
      }
      if (view === undefined || String(view.session.id) !== String(command.sessionId)) {
        return json(refusedCommand("session-not-found"), 404, origin);
      }
      if (command.expectedVersion !== view.session.version) {
        return json(refusedCommand("stale-version"), 409, origin);
      }
      if (command.kind === "pause-native-harness-session") {
        if (view.session.status !== "running" && view.session.status !== "idle") {
          return json(refusedCommand("not-running"), 409, origin);
        }
        dependencies.store.pause(threadId, "paused-by-user", "Paused by the user.");
      } else if (command.kind === "resume-native-harness-session") {
        if (!dependencies.store.resume(threadId)) {
          return json(refusedCommand("not-paused"), 409, origin);
        }
      } else {
        dependencies.interruptTurn?.({ threadId, windowId });
      }
      const updated = dependencies.store.read(threadId);
      const result: NativeHarnessSessionCommandResult = {
        kind: "native-harness-session",
        session: (updated ?? view).session,
      };
      return json(result, 200, origin);
    }

    if (action === "approvals") {
      let decision;
      try {
        decision = decodeDecideNativeHarnessApproval(body);
      } catch {
        return failure("Native harness approval decision is invalid.", 400, origin);
      }
      const outcome = dependencies.decideApproval?.({
        threadId,
        approvalId: String(decision.approvalId),
        decision: decision.decision,
      });
      const settled = dependencies.store
        .read(threadId)
        ?.approvals?.find((approval) => String(approval.id) === String(decision.approvalId));
      const result: NativeHarnessApprovalDecisionResult =
        outcome === "decided" && settled !== undefined
          ? { kind: "approval-decided", approval: settled }
          : {
              kind: "approval-refused",
              approvalId: decision.approvalId,
              reason: outcome === "already-settled" ? "already-settled" : "approval-not-found",
              message:
                outcome === "already-settled"
                  ? "That approval was already decided."
                  : "No pending approval has that id on this thread.",
            };
      return json(result, result.kind === "approval-decided" ? 200 : 409, origin);
    }

    if (action === "steering") {
      let command;
      try {
        command = decodeSteerNativeHarnessSession(body);
      } catch {
        return failure("Native harness steering note is invalid.", 400, origin);
      }
      const accepted = dependencies.steer?.({ threadId, command }) ?? false;
      if (!accepted) return failure("The steering queue is full.", 409, origin);
      return json({ view: dependencies.store.read(threadId) ?? null }, 200, origin);
    }

    if (action === "questions") {
      let answer;
      try {
        answer = decodeAnswerNativeHarnessQuestion(body);
      } catch {
        return failure("Native harness question answer is invalid.", 400, origin);
      }
      const outcome = dependencies.answerQuestion?.({
        threadId,
        questionId: String(answer.questionId),
        answer: answer.answer,
      });
      const settled = dependencies.store
        .read(threadId)
        ?.questions.find((question) => String(question.id) === String(answer.questionId));
      const result: NativeHarnessQuestionAnswerResult =
        outcome === "answered" && settled !== undefined
          ? { kind: "question-answered", question: settled }
          : {
              kind: "question-refused",
              questionId: answer.questionId,
              reason: outcome === "already-settled" ? "already-settled" : "question-not-found",
              message:
                outcome === "already-settled"
                  ? "That question was already answered."
                  : "No pending question has that id on this thread.",
            };
      return json(result, result.kind === "question-answered" ? 200 : 409, origin);
    }

    if (action === "follow-ups") {
      const [, , sub = ""] = url.pathname.slice(PREFIX.length).split("/");
      const settled = await settleFollowUpSuggestion(dependencies.followUps, {
        threadId,
        windowId,
        action: sub,
        body,
      });
      return json(settled.body, settled.status, origin);
    }
    return failure("Unknown native harness session action.", 404, origin);
  };
}

function refusedCommand(
  reason: Extract<
    NativeHarnessSessionCommandResult,
    { kind: "native-harness-session-refused" }
  >["reason"],
): NativeHarnessSessionCommandResult {
  return {
    kind: "native-harness-session-refused",
    reason,
    message: `The harness session command was refused: ${reason}.`,
  };
}
