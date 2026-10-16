import {
  decodeProviderSessionId,
  NATIVE_HARNESS_BUILT_IN_SLOTS,
  nativeHarnessSlotCandidateKey,
  type NativeHarnessRouteDecision,
  type NativeHarnessRouteFailureReason,
  type NativeHarnessSlotCandidate,
  type OctantMode,
  type ProjectId,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { routeFailureReason } from "./nativeHarnessLeadFallback";
import type { NativeHarnessRouter } from "./nativeHarnessRouter";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";
import { completeOnceOutcome } from "./nativeHarnessSingleShot";
import type { NativeHarnessToolPorts } from "./nativeHarnessTools";

const SECOND_OPINION_TIMEOUT_MS = 60_000;
/** Primary, then a fallback or two; a slot's chain is short. */
const MAX_ATTEMPTS = 3;

const SECOND_OPINION_INSTRUCTIONS = [
  "Another model is working on a task and asks for your advice on one question.",
  "Answer plainly and briefly. Your answer is advice the asker may weigh and set aside.",
  "You cannot run tools, read files, or approve anything.",
].join("\n");

export interface NativeHarnessSecondOpinionOptions {
  readonly router: Pick<NativeHarnessRouter, "resolve" | "reportFailure">;
  readonly sessions: Pick<NativeHarnessSessionStore, "ensure" | "recordRouteDecision">;
  readonly resolveDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  /** A directory outside every Project, where the advisor's one-shot session starts. */
  readonly scratchRoot: string;
  readonly uuid: () => string;
  readonly complete?: typeof completeOnceOutcome;
}

/**
 * The advisor behind `second-opinion`: one question, one tool-less reply, on
 * the model chosen for the `advisor` slot. It reaches no file, shell, or
 * network of the asking thread, so the same port serves Chat, Work, and Code.
 * Each routing decision is journaled on the asking thread's session, and a
 * model that fails sits out its cooldown so the slot's next candidate answers.
 * With no advisor model chosen it answers nothing and the tool says so.
 */
export function createNativeHarnessSecondOpinionPort(
  options: NativeHarnessSecondOpinionOptions,
  scope: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
  },
): NonNullable<NativeHarnessToolPorts["secondOpinion"]> {
  const record = (decision: NativeHarnessRouteDecision) => {
    try {
      options.sessions.ensure({
        threadId: scope.threadId,
        mode: scope.mode,
        projectId: scope.projectId,
        leadSlotId: NATIVE_HARNESS_BUILT_IN_SLOTS.default,
        lead: scope.lead,
      });
      options.sessions.recordRouteDecision(scope.threadId, decision);
    } catch {
      // The journal refusing a record never decides whether the lead is answered.
    }
  };
  return async ({ question, signal }) => {
    const tried = new Set<string>();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted === true) return undefined;
      const decision = options.router.resolve({ job: "advisor", projectId: scope.projectId });
      record(decision);
      if (decision.kind === "unroutable") return undefined;
      const key = nativeHarnessSlotCandidateKey(decision.candidate);
      if (tried.has(key)) return undefined;
      tried.add(key);
      const driver = options.resolveDriver(decision.candidate.providerInstanceId);
      if (driver === undefined) return undefined;
      const asking = (options.complete ?? completeOnceOutcome)({
        driver,
        providerInstanceId: decision.candidate.providerInstanceId,
        modelId: decision.candidate.modelId,
        sessionId: decodeProviderSessionId(options.uuid()),
        projectRoot: options.scratchRoot,
        instructions: SECOND_OPINION_INSTRUCTIONS,
        prompt: question,
        timeoutMs: SECOND_OPINION_TIMEOUT_MS,
      });
      // A cancelled turn stops waiting; the one-shot session ends on its own timeout.
      const outcome = await (signal === undefined
        ? asking
        : Promise.race([
            asking,
            new Promise<{ readonly status: "interrupted" }>((resolve) => {
              if (signal.aborted) resolve({ status: "interrupted" });
              signal.addEventListener("abort", () => resolve({ status: "interrupted" }), {
                once: true,
              });
            }),
          ]));
      if (outcome.status === "completed") {
        const trimmed = outcome.text.trim();
        return trimmed.length === 0 ? undefined : trimmed;
      }
      const reason: NativeHarnessRouteFailureReason | undefined =
        outcome.status === "failed"
          ? routeFailureReason(outcome.failure)
          : outcome.status === "timed-out"
            ? "timeout"
            : outcome.status === "unreached"
              ? "endpoint-unavailable"
              : undefined;
      // A reply withheld or a turn cancelled is not the model's failure.
      if (reason === undefined) return undefined;
      options.router.reportFailure({
        slotId: decision.kind === "inherited-parent" ? decision.requestedSlotId : decision.slotId,
        candidate: decision.candidate,
        reason,
        ...(outcome.status === "failed" && outcome.failure.retryAfterMs !== undefined
          ? { retryAfterMs: outcome.failure.retryAfterMs }
          : {}),
      });
    }
    return undefined;
  };
}
