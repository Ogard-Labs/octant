import {
  nativeHarnessSlotCandidateKey,
  type NativeHarnessRouteFailureReason,
  type NativeHarnessSlotCandidate,
  type ProviderFailure,
} from "@octant/contracts";
import type { NativeHarnessEndpoint } from "./nativeHarnessEndpointRegistry";
import type { NativeHarnessRouter } from "./nativeHarnessRouter";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";
import type { NativeHarnessTurnScope } from "./nativeHarnessTurnObserver";
import type {
  NativeHarnessLeadFallback,
  NativeHarnessLeadFallbackOutcome,
  NativeHarnessLeadTarget,
} from "./nativeHarnessTransport";

export interface NativeHarnessLeadFallbackOptions {
  readonly router: Pick<NativeHarnessRouter, "resolve" | "reportFailure">;
  readonly sessions: Pick<NativeHarnessSessionStore, "recordRouteDecision">;
  readonly hostId: string;
  /** The direct endpoint behind a provider instance, when it is one that runs the harness. */
  readonly endpointFor: (providerInstanceId: string) => NativeHarnessEndpoint | undefined;
}

type NoFallback = Extract<NativeHarnessLeadFallbackOutcome, { status: "none" }>;

/**
 * Carries a lead turn over to the next configured model once its own model
 * has used up the endpoint's retries.
 *
 * The lead runs on the model its thread chose, not on whatever the `default`
 * slot lists first, so the router is only consulted when that model fails: the
 * failure is reported (the model sits out a cooldown and the slot's breaker
 * counts it) and the lead job is resolved again, which skips what is cooling
 * down. The decision is journaled on each thread's harness session, the same
 * record delegation and the advisor write, whether it found a model or not.
 *
 * A failed request belongs to whichever turns are running on that model, so
 * the service tracks the harness turns the host started. A Project's own slot
 * table may narrow the host's; when turns of different Projects share the
 * failed model the fallback is taken only if their tables agree.
 */
export class NativeHarnessLeadFallbackService implements NativeHarnessLeadFallback {
  readonly #options: NativeHarnessLeadFallbackOptions;
  readonly #active = new Map<string, NativeHarnessTurnScope>();

  constructor(options: NativeHarnessLeadFallbackOptions) {
    this.#options = options;
  }

  turnStarted(scope: NativeHarnessTurnScope): void {
    this.#active.set(scope.threadId, scope);
  }

  turnEnded(scope: NativeHarnessTurnScope): void {
    this.#active.delete(scope.threadId);
  }

  readonly next: NativeHarnessLeadFallback["next"] = async (input) => {
    const route = this.#route(input);
    if (route.status === "none") return route;
    const target: NativeHarnessLeadTarget = {
      providerInstanceId: route.candidate.providerInstanceId,
      modelId: route.candidate.modelId,
    };
    const endpoint = this.#options.endpointFor(String(target.providerInstanceId));
    if (endpoint === undefined || endpoint.admitTurn(input.turn, target.modelId) !== undefined) {
      return { status: "none", reason: "refused" };
    }
    try {
      return { status: "switched", target, endpoint: await endpoint.open(target.modelId) };
    } catch {
      return { status: "none", reason: "refused" };
    }
  };

  #route(input: {
    readonly failed: NativeHarnessLeadTarget;
    readonly attempted: ReadonlyArray<NativeHarnessLeadTarget>;
    readonly failure: ProviderFailure;
  }):
    | NoFallback
    | { readonly status: "candidate"; readonly candidate: NativeHarnessSlotCandidate } {
    // A turn is tracked under the model its thread chose, which is the first
    // one it ran on; later entries are models it already moved to.
    const own = input.attempted[0] ?? input.failed;
    const scopes = [...this.#active.values()].filter(
      (scope) =>
        String(scope.providerInstanceId) === String(own.providerInstanceId) &&
        String(scope.modelId) === String(own.modelId),
    );
    if (scopes.length === 0) return { status: "none", reason: "not-routed" };

    const failed = this.#candidate(input.failed);
    const tried = new Set(
      input.attempted.map((target) => nativeHarnessSlotCandidateKey(this.#candidate(target))),
    );
    const byProject = new Map<string, NativeHarnessTurnScope[]>();
    for (const scope of scopes) {
      const key = scope.projectId === undefined ? "" : String(scope.projectId);
      byProject.set(key, [...(byProject.get(key) ?? []), scope]);
    }

    const chosen = new Map<string, NativeHarnessSlotCandidate>();
    let refusal: NoFallback | undefined;
    const reportedSlots = new Set<string>();
    for (const [key, group] of byProject) {
      const projectId = group[0]?.projectId;
      const before = this.#options.router.resolve({ job: "lead", projectId });
      // A lead resolves without a parent to inherit, so only the type admits
      // `inherited-parent`; its requested slot is the one that failed.
      const slotId = before.kind === "inherited-parent" ? before.requestedSlotId : before.slotId;
      // Projects that share a slot share one failed request; counting it once
      // per Project would open the slot's breaker early.
      if (!reportedSlots.has(String(slotId))) {
        reportedSlots.add(String(slotId));
        this.#options.router.reportFailure({
          slotId,
          candidate: failed,
          reason: routeFailureReason(input.failure),
          ...(input.failure.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: input.failure.retryAfterMs }),
        });
      }
      const decision = this.#options.router.resolve({ job: "lead", projectId });
      for (const scope of group) {
        try {
          this.#options.sessions.recordRouteDecision(scope.threadId, decision);
        } catch {
          // The journal refusing a record never decides where the turn goes.
        }
      }
      if (decision.kind === "unroutable") {
        refusal ??= { status: "none", reason: decision.reason };
      } else if (tried.has(nativeHarnessSlotCandidateKey(decision.candidate))) {
        refusal ??= { status: "none", reason: "no-other-model" };
      } else {
        chosen.set(key, decision.candidate);
      }
    }
    if (refusal !== undefined) return refusal;
    const candidates = [...chosen.values()];
    const first = candidates[0];
    if (
      first === undefined ||
      candidates.some(
        (candidate) =>
          nativeHarnessSlotCandidateKey(candidate) !== nativeHarnessSlotCandidateKey(first),
      )
    ) {
      return { status: "none", reason: "no-other-model" };
    }
    return { status: "candidate", candidate: first };
  }

  #candidate(target: NativeHarnessLeadTarget): NativeHarnessSlotCandidate {
    return {
      hostId: this.#options.hostId as never,
      providerInstanceId: target.providerInstanceId,
      modelId: target.modelId,
    };
  }
}

/** Why the router should keep a failed model out of the chain for a while. */
function routeFailureReason(failure: ProviderFailure): NativeHarnessRouteFailureReason {
  switch (failure.category) {
    case "rate-limited":
      return "rate-limited";
    case "unauthenticated":
    case "unauthorized":
      return "authentication-failed";
    case "provider-failed":
      return "server-error";
    default:
      return /timed out/i.test(failure.message) ? "timeout" : "endpoint-unavailable";
  }
}
