import { principalActsAsHostPerson } from "../clientPrincipal";
import {
  type EventActor,
  decodeAnswerNativeHarnessQuestion,
  decodeDecideNativeHarnessApproval,
  decodeSteerNativeHarnessSession,
  type NativeHarnessApprovalDecisionResult,
  type NativeHarnessChildRequestsView,
  type NativeHarnessSessionView,
  type NativeHarnessSteeringNote,
  type SteerNativeHarnessSession,
  decodeNativeHarnessSessionCommand,
  type NativeHarnessQuestionAnswerResult,
  type NativeHarnessSessionCommandResult,
} from "@octant/contracts";
import { APPROVAL_POSTURE_CHANGED_MESSAGE } from "@octant/domain/guardrail-policy";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  settleFollowUpSuggestion,
  type FollowUpSuggestionActionDependencies,
} from "../followUps/followUpSuggestionRoutes";
import type { NativeHarnessApprovalAnswer } from "./nativeHarnessApprovals";
import type { ToolEgressPerson } from "./nativeHarnessEgressRules";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const PREFIX = "/api/native-harness/sessions/";

export interface NativeHarnessSessionRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly mayAnswerChildFromDevice?: (input: {
    readonly runId: string;
    readonly parentThreadId: string;
    readonly deviceId: string;
  }) => boolean;
  readonly store: Pick<NativeHarnessSessionStore, "read" | "pause" | "resume" | "turnInFlight">;
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
  /**
   * What stands in the way of lifting a recovery, in words a person can act
   * on: the thread's folder or model is gone or unusable. Empty when it may
   * resume. Asked only for `recovery-required`; a plain pause re-admits the
   * same thread it paused.
   */
  readonly recoveryBlockers?: (input: {
    readonly threadId: string;
  }) => Promise<ReadonlyArray<string>>;
  /**
   * Settles the mode's orphaned turns before a continuation is queued, while
   * recovery still prevents dispatch. A hold-only resume settles them afterward.
   */
  readonly settleInterruptedTurns?: (input: {
    readonly threadId: string;
    readonly mode: NativeHarnessSessionView["session"]["mode"];
  }) => void;
  readonly continueRecovery?: (input: {
    readonly threadId: string;
    readonly windowId: string;
    readonly mode: NativeHarnessSessionView["session"]["mode"];
  }) => Promise<
    { readonly kind: "queued" } | { readonly kind: "refused"; readonly message: string }
  >;
  /** Stops what would start new work on its own while the session is paused. */
  readonly onPaused?: (input: { readonly threadId: string }) => void;
  readonly decideApproval?: (input: {
    readonly threadId: string;
    readonly approvalId: string;
    readonly decision: "approve" | "approve-always" | "deny";
    /** Who decided, from the authenticated request, and the hosts they ticked. */
    readonly answer: NativeHarnessApprovalAnswer;
  }) =>
    | "decided"
    | "approval-not-found"
    | "already-settled"
    | "withdrawn"
    | "host-not-offered"
    | "lost-in-restart"
    | "posture-changed";
  readonly steer?: (input: {
    readonly threadId: string;
    readonly command: SteerNativeHarnessSession;
    /** Who sent, took or cleared the note, as the route resolved it. */
    readonly actor: EventActor;
  }) =>
    | "queued"
    | "cleared"
    | "full"
    | "no-session"
    | { readonly taken: ReadonlyArray<NativeHarnessSteeringNote> };
  /** Settles a pending question from any surface; the outcome says why it could not. */
  readonly answerQuestion?: (input: {
    readonly threadId: string;
    readonly questionId: string;
    readonly answer: string;
    /** Who answered, from the authenticated request. */
    readonly actor: EventActor;
  }) => "answered" | "question-not-found" | "already-settled" | "invalid-answer";
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
  const commanding = new Set<string>();
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
    let person: ToolEgressPerson;
    let actor: EventActor;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      windowId = String(context.scopeId);
      // A device the host's own person paired answers a thread's requests as a
      // local window does. Any other device session answers only the child
      // requests its own turns raised, once each.
      // The device is named either way, so what it decides is journaled as its own.
      person =
        context.principal.kind !== "remote-device"
          ? { kind: "local-window" }
          : {
              kind: principalActsAsHostPerson(context.principal)
                ? "person-paired-device"
                : "remote-device",
              deviceId: String(context.principal.deviceId),
            };
      actor = eventActorForPrincipal(context.principal);
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Native harness session request is unauthorized.", 401, origin);
      }
      return failure("Native harness session request is invalid.", 400, origin);
    }
    const [threadId = "", action = ""] = url.pathname.slice(PREFIX.length).split("/");
    if (threadId.length === 0) return failure("Thread id is required.", 400, origin);
    if (
      person.kind !== "remote-device" &&
      !(await dependencies.authorizeThread({ threadId, windowId }))
    ) {
      return failure("Native harness session request is unauthorized.", 403, origin);
    }
    const rawView = dependencies.store.read(threadId);
    const eligibleChild = (item: {
      readonly source?: { readonly runId: unknown } | undefined;
    }): boolean =>
      person.kind !== "remote-device" ||
      (item.source !== undefined &&
        dependencies.mayAnswerChildFromDevice?.({
          runId: String(item.source.runId),
          parentThreadId: threadId,
          deviceId: person.deviceId,
        }) === true);
    const approvals =
      person.kind === "remote-device" ? (rawView?.approvals ?? []).filter(eligibleChild) : [];
    const questions =
      person.kind === "remote-device" ? (rawView?.questions ?? []).filter(eligibleChild) : [];
    const view = rawView;
    if (
      person.kind === "remote-device" &&
      action !== "" &&
      action !== "approvals" &&
      action !== "questions"
    )
      return failure("A paired device may answer only its own child requests here.", 403, origin);

    if (request.method === "GET" && action === "") {
      if (person.kind === "remote-device") {
        const pending =
          approvals.some((item) => item.status === "pending") ||
          questions.some((item) => item.status === "pending");
        const childView: NativeHarnessChildRequestsView | null =
          !pending || rawView === undefined
            ? null
            : { kind: "child-requests", approvals, questions };
        return json({ view: childView }, 200, origin);
      }
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
      if (commanding.has(threadId)) return json(refusedCommand("stale-version"), 409, origin);
      commanding.add(threadId);
      try {
        const view = dependencies.store.read(threadId);
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
          // A pause drains: the turn running now and the helpers it started
          // finish, and nothing new is admitted until a person resumes.
          dependencies.store.pause(
            threadId,
            "paused-by-user",
            dependencies.store.turnInFlight(threadId)
              ? "Paused by the user. The current turn will finish; nothing new starts."
              : "Paused by the user.",
            actor,
          );
          dependencies.onPaused?.({ threadId });
        } else if (command.kind === "resume-native-harness-session") {
          const liftsRecovery = view.session.status === "recovery-required";
          if (command.continueInterrupted === true && !liftsRecovery) {
            return json(refusedCommand("not-paused"), 409, origin);
          }
          if (liftsRecovery) {
            const blockers = (await dependencies.recoveryBlockers?.({ threadId })) ?? [];
            if (blockers.length > 0) {
              return json(
                refusedCommand(
                  "not-ready",
                  `Not ready to resume: ${blockers.join(" ")}`.slice(0, 512),
                ),
                409,
                origin,
              );
            }
          }
          if (command.continueInterrupted === true) {
            dependencies.settleInterruptedTurns?.({ threadId, mode: view.session.mode });
            const continuation = await dependencies.continueRecovery?.({
              threadId,
              windowId,
              mode: view.session.mode,
            });
            if (continuation?.kind !== "queued") {
              return json(
                refusedCommand(
                  "not-ready",
                  continuation?.message ?? "Restart continuation is unavailable on this host.",
                ),
                409,
                origin,
              );
            }
          }
          if (!dependencies.store.resume(threadId, actor)) {
            return json(refusedCommand("not-paused"), 409, origin);
          }
          if (liftsRecovery && command.continueInterrupted !== true) {
            dependencies.settleInterruptedTurns?.({ threadId, mode: view.session.mode });
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
      } finally {
        commanding.delete(threadId);
      }
    }

    if (action === "approvals") {
      let decision;
      try {
        decision = decodeDecideNativeHarnessApproval(body);
      } catch {
        return failure("Native harness approval decision is invalid.", 400, origin);
      }
      if (
        person.kind === "remote-device" &&
        (decision.decision === "approve-always" ||
          !approvals.some(
            (item) => String(item.id) === String(decision.approvalId) && item.status === "pending",
          ))
      )
        return failure(
          "This child request does not belong to this device's turn, or is no longer pending.",
          403,
          origin,
        );
      const outcome = dependencies.decideApproval?.({
        threadId,
        approvalId: String(decision.approvalId),
        decision: decision.decision,
        // The principal comes from the request, never the body.
        answer: {
          principal: person,
          actor,
          ...(decision.commandHosts === undefined ? {} : { commandHosts: decision.commandHosts }),
        },
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
              reason:
                outcome === "already-settled" ||
                outcome === "withdrawn" ||
                outcome === "host-not-offered" ||
                outcome === "lost-in-restart" ||
                outcome === "posture-changed"
                  ? outcome
                  : "approval-not-found",
              message:
                outcome === "already-settled"
                  ? "That approval was already decided."
                  : outcome === "withdrawn"
                    ? "That approval was withdrawn before anyone answered it, so nothing was decided."
                    : outcome === "host-not-offered"
                      ? "This command can reach only hosts its approval lists. Nothing was decided."
                      : outcome === "lost-in-restart"
                        ? "Octant restarted while this was waiting, so the call did not run. Resume the session; the agent asks again if it still needs it."
                        : outcome === "posture-changed"
                          ? APPROVAL_POSTURE_CHANGED_MESSAGE
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
      const outcome = dependencies.steer?.({ threadId, command, actor }) ?? "no-session";
      if (typeof outcome === "object") {
        return json(
          { view: dependencies.store.read(threadId) ?? null, taken: outcome.taken },
          200,
          origin,
        );
      }
      if (outcome === "full") return failure("The steering queue is full.", 409, origin);
      if (outcome === "no-session") {
        return failure(
          "This thread has no harness run to steer yet. Send a message to start one.",
          409,
          origin,
        );
      }
      return json({ view: dependencies.store.read(threadId) ?? null }, 200, origin);
    }

    if (action === "questions") {
      let answer;
      try {
        answer = decodeAnswerNativeHarnessQuestion(body);
      } catch {
        return failure("Native harness question answer is invalid.", 400, origin);
      }
      if (
        person.kind === "remote-device" &&
        !questions.some(
          (item) => String(item.id) === String(answer.questionId) && item.status === "pending",
        )
      )
        return failure(
          "This child request does not belong to this device's turn, or is no longer pending.",
          403,
          origin,
        );
      const outcome = dependencies.answerQuestion?.({
        threadId,
        questionId: String(answer.questionId),
        answer: answer.answer,
        actor,
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
              reason:
                outcome === "invalid-answer"
                  ? "invalid-answer"
                  : outcome === "already-settled"
                    ? "already-settled"
                    : "question-not-found",
              message:
                outcome === "invalid-answer"
                  ? "The questionnaire answer is incomplete or contains invalid choices."
                  : outcome === "already-settled"
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
        actor,
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
  message?: string,
): NativeHarnessSessionCommandResult {
  return {
    kind: "native-harness-session-refused",
    reason,
    message: message ?? `The harness session command was refused: ${reason}.`,
  };
}
