import {
  decodeActivateNativeHarnessFollowUp,
  decodeAnswerNativeHarnessQuestion,
  decodeNativeHarnessFollowUpPreview,
  decodeNativeHarnessSessionCommand,
  type NativeHarnessFollowUpActivationResult,
  type NativeHarnessFollowUpCreation,
  type NativeHarnessFollowUpSuggestion,
  type NativeHarnessQuestionAnswerResult,
  type NativeHarnessSessionCommandResult,
  type NativeHarnessSessionView,
} from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const PREFIX = "/api/native-harness/sessions/";

export interface NativeHarnessSessionRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly store: Pick<NativeHarnessSessionStore, "read" | "pause" | "resume" | "activateFollowUp">;
  /** Whether this window may read and steer the thread; never a body field. */
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) => boolean | Promise<boolean>;
  /** What activating a suggestion would create for this thread, decided by the host. */
  readonly previewFollowUp: (input: {
    readonly view: NativeHarnessSessionView;
    readonly suggestion: NativeHarnessFollowUpSuggestion;
  }) => NativeHarnessFollowUpCreation | undefined;
  readonly interruptTurn?: (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) => void;
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
 * The harness session as every surface reads it, plus the two things a person
 * may do to it: pause or resume the run, and turn a suggested follow-up into
 * a preview and then an activation. Activation records the decision; the
 * thread it names is created through the surface's ordinary creation command
 * with the suggestion's prompt, so no new creation path exists here.
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
      const record = (body ?? {}) as Record<string, unknown>;
      const suggestion = view?.followUps?.suggestions.find(
        (entry) => String(entry.id) === String(record.suggestionId),
      );
      if (view === undefined || suggestion === undefined) {
        return json(
          refusedFollowUp(String(record.suggestionId ?? ""), "suggestion-not-found"),
          404,
          origin,
        );
      }
      const created = dependencies.previewFollowUp({ view, suggestion });
      if (created === undefined) {
        return json(refusedFollowUp(String(suggestion.id), "target-unavailable"), 409, origin);
      }
      if (sub === "preview") {
        const preview = decodeNativeHarnessFollowUpPreview({ suggestion, wouldCreate: created });
        return json({ preview }, 200, origin);
      }
      if (sub === "activate") {
        let activation;
        try {
          activation = decodeActivateNativeHarnessFollowUp(body);
        } catch {
          return failure("Follow-up activation requires an explicit confirmation.", 400, origin);
        }
        const outcome = dependencies.store.activateFollowUp(
          threadId,
          activation.suggestionId,
          created,
        );
        if (outcome !== "activated") {
          return json(refusedFollowUp(String(suggestion.id), outcome), 409, origin);
        }
        const result: NativeHarnessFollowUpActivationResult = {
          kind: "follow-up-activated",
          suggestionId: suggestion.id,
          created,
        };
        return json(result, 200, origin);
      }
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

function refusedFollowUp(
  suggestionId: string,
  reason: Extract<NativeHarnessFollowUpActivationResult, { kind: "follow-up-refused" }>["reason"],
): NativeHarnessFollowUpActivationResult {
  return {
    kind: "follow-up-refused",
    suggestionId: suggestionId as never,
    reason,
    message: `The follow-up was refused: ${reason}.`,
  };
}
