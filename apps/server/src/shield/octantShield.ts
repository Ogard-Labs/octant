import {
  decodeShieldDecision,
  MAX_SHIELD_REASON_LENGTH,
  SHIELD_WATCHER_LABELS,
  type GuardrailLevel,
  type SafeNetworkPlace,
  type ShieldDecision,
  type ShieldModelChoice,
  type ShieldStage,
  type ShieldVerdict,
  type ShieldWatcherLabel,
  type TurnUsage,
} from "@octant/contracts";
import {
  judgeShieldCallByRules,
  nextShieldBrakeState,
  parseShieldModelAnswer,
  SHIELD_BRAKE_RELEASED,
  SHIELD_JUDGE_INSTRUCTIONS,
  shieldBrakeEngaged,
  shieldJudgePrompt,
  type ShieldBrakeState,
  type ShieldCall,
  type ShieldJudgeInput,
} from "@octant/domain/shield-judge-policy";
import type { ShieldServerRule } from "@octant/domain/shield-server-policy";

/** How long the model may take before Shield hands the call to the person. */
export const SHIELD_MODEL_TIMEOUT_MS = 20_000;

export type ShieldModelOutcome =
  | {
      readonly status: "answered";
      readonly text: string;
      /** What the provider reported the call used; absent when it reported nothing. */
      readonly usage?: TurnUsage;
    }
  | { readonly status: "unreached" | "timed-out" | "failed" };

/** One configured model the Judge asks, by one prompt and one reply, with no tools. */
export interface ShieldModelPort {
  readonly model: ShieldModelChoice;
  readonly complete: (input: {
    readonly instructions: string;
    readonly prompt: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  }) => Promise<ShieldModelOutcome>;
}

/**
 * Shield's model calls count against the thread's and Project's spend
 * ceilings: a call reserves before it runs, and settling records what it used
 * under the thread (unreported when the provider said nothing) before the
 * reservation is released.
 */
export interface ShieldSpendPort {
  readonly admit: (scope: {
    readonly threadId: string;
    readonly projectId?: string | undefined;
    readonly model: ShieldModelChoice;
  }) =>
    | { readonly status: "admitted"; readonly settle: (usage: TurnUsage | undefined) => void }
    | {
        readonly status: "refused";
        readonly reason: string;
      };
}

/**
 * The thread facts Shield reads when a prompt arrives. `reviewing` answers
 * undefined when Shield is not this thread's reviewer right now (not Auto,
 * another reviewer, Plan, Full access), and the prompt goes where it went
 * before Shield existed.
 */
export interface ShieldThreadFacts {
  readonly reviewing: (threadId: string) =>
    | {
        readonly projectId?: string | undefined;
        readonly level: GuardrailLevel;
        /** The model that judges this thread, or undefined when none resolves. */
        readonly model: ShieldModelPort | undefined;
      }
    | undefined;
  readonly tainted: (threadId: string) => boolean;
  /** What the Watcher found in what the thread read: kinds only, never text. */
  readonly watcherLabels: (threadId: string) => ReadonlyArray<ShieldWatcherLabel>;
  /** The person's own messages in the thread, oldest first. Nothing the agent read. */
  readonly personMessages: (threadId: string) => ReadonlyArray<string>;
  readonly projectCommands: (boundRoot: string) => ReadonlyArray<string>;
  /** The servers the person registered; SSH to any other host goes to the person. */
  readonly servers?: () => ReadonlyArray<ShieldServerRule>;
  /** The secret guard's list in force: whether a path is one it protects. */
  readonly protectedSecretPath?: (path: string) => boolean;
  /** The places trusted for a Project while Network limits are on; none while they are off. */
  readonly safePlaces?: (projectId: string | undefined) => ReadonlyArray<SafeNetworkPlace>;
}

export interface OctantShieldOptions {
  readonly facts: ShieldThreadFacts;
  readonly spend?: ShieldSpendPort | undefined;
  readonly clock: () => string;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
}

export interface ShieldReviewRequest {
  /** The thread whose prompts Shield answers; a subagent asks under its parent's. */
  readonly threadId: string;
  readonly call: ShieldCall;
  readonly boundRoot: string;
  /** The Project's extra folders, judged as the bound root is. */
  readonly extraRoots?: ReadonlyArray<string> | undefined;
  /** A subagent's own taint, which counts beside its parent's. */
  readonly alsoTainted?: boolean | undefined;
  /** What the Watcher found in what a subagent read, beside its parent's. */
  readonly alsoWatcherLabels?: ReadonlyArray<ShieldWatcherLabel> | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** One decision for a thread's transcript. */
export interface ShieldTranscriptRecord {
  readonly threadId: string;
  readonly summary: string;
  readonly decision: ShieldDecision;
  /**
   * The call the approval was for and its tool, which key a Work turn's
   * review row; a Code transcript appends the decision as its own row.
   */
  readonly requestId?: string | undefined;
  readonly toolName?: string | undefined;
}

/**
 * How an approval path reaches Shield: `review` answers undefined when Shield
 * is not the thread's reviewer, and `recordOnTranscript` shows a decision on
 * the thread's transcript beside its tool rows.
 */
export interface ShieldReviewPort {
  readonly review: (request: ShieldReviewRequest) => Promise<ShieldDecision | undefined>;
  readonly recordOnTranscript?: (input: ShieldTranscriptRecord) => void;
}

/**
 * Octant Shield's Judge as the host runs it: the rule stages, then the model,
 * with the brakes kept per thread. It answers allow, ask, or deny, and every
 * failure (a malformed answer, a timeout, an unreachable model, a spend
 * ceiling) is an ask, so Shield fails closed to the person. It grants one call
 * at a time and never anything standing.
 *
 * The brakes live in memory for the host's lifetime: a restart gives a paused
 * thread back to Shield, which is no wider than before the denials, since
 * every denial was itself only a refusal.
 */
export class OctantShield {
  readonly #options: OctantShieldOptions;
  readonly #brakes = new Map<string, ShieldBrakeState>();

  constructor(options: OctantShieldOptions) {
    this.#options = options;
  }

  /** Whether Shield answers this thread's prompts right now. */
  reviews(threadId: string): boolean {
    return this.#options.facts.reviewing(threadId) !== undefined;
  }

  /**
   * Shield's decision on one pending call, or undefined when Shield is not
   * this thread's reviewer, so the caller asks as it always did.
   */
  async review(request: ShieldReviewRequest): Promise<ShieldDecision | undefined> {
    const facts = this.#options.facts;
    const reviewing = facts.reviewing(request.threadId);
    if (reviewing === undefined) return undefined;
    const nowMs = this.#options.nowMs ?? Date.now;
    const startedAt = nowMs();
    const decide = (
      verdict: ShieldVerdict,
      stage: ShieldStage,
      reason: string,
      extra: { readonly rule?: string; readonly model?: ShieldModelChoice } = {},
    ): ShieldDecision => {
      const decision = decodeShieldDecision({
        reviewer: "octant-shield",
        verdict,
        stage,
        ...(extra.rule === undefined ? {} : { rule: extra.rule }),
        reason: reason.slice(0, MAX_SHIELD_REASON_LENGTH),
        ...(extra.model === undefined ? {} : { model: extra.model }),
        latencyMs: Math.max(0, Math.round(nowMs() - startedAt)),
        decidedAt: this.#options.clock(),
      });
      const brake = this.#brakes.get(request.threadId) ?? SHIELD_BRAKE_RELEASED;
      this.#brakes.set(
        request.threadId,
        nextShieldBrakeState(brake, stage === "brake" ? "braked" : verdict),
      );
      return decision;
    };

    const brake = shieldBrakeEngaged(this.#brakes.get(request.threadId) ?? SHIELD_BRAKE_RELEASED);
    if (brake.engaged) return decide("ask", "brake", brake.reason, { rule: "denial-brake" });

    const ownLabels = facts.watcherLabels(request.threadId);
    const watcherLabels = SHIELD_WATCHER_LABELS.filter(
      (label) => ownLabels.includes(label) || request.alsoWatcherLabels?.includes(label) === true,
    );
    // A label is only ever raised on content the thread read, so a labelled
    // thread is marked even if its mark could not be read.
    const tainted =
      facts.tainted(request.threadId) || request.alsoTainted === true || watcherLabels.length > 0;
    const input: ShieldJudgeInput = {
      call: request.call,
      boundRoot: request.boundRoot,
      ...(request.extraRoots === undefined ? {} : { extraRoots: request.extraRoots }),
      tainted,
      projectCommands: facts.projectCommands(request.boundRoot),
      servers: facts.servers?.() ?? [],
      ...(facts.protectedSecretPath === undefined
        ? {}
        : { protectedSecretPath: facts.protectedSecretPath }),
      safePlaces: facts.safePlaces?.(reviewing.projectId) ?? [],
      level: reviewing.level,
      personMessages: facts.personMessages(request.threadId),
      watcherLabels,
    };
    const ruled = judgeShieldCallByRules(input);
    if (ruled.kind === "decided") {
      return decide(ruled.verdict, ruled.stage, ruled.reason, { rule: ruled.rule });
    }

    const model = reviewing.model;
    if (model === undefined) {
      return decide("ask", "fail-closed", "No Shield model is reachable, so the person decides.", {
        rule: "no-model",
      });
    }
    const admission = this.#options.spend?.admit({
      threadId: request.threadId,
      projectId: reviewing.projectId,
      model: model.model,
    });
    if (admission?.status === "refused") {
      return decide("ask", "fail-closed", `${admission.reason} The person decides this call.`, {
        rule: "spend-ceiling",
        model: model.model,
      });
    }
    let outcome: ShieldModelOutcome;
    try {
      outcome = await withTimeout(
        model.complete({
          instructions: SHIELD_JUDGE_INSTRUCTIONS,
          prompt: shieldJudgePrompt(input),
          timeoutMs: this.#options.timeoutMs ?? SHIELD_MODEL_TIMEOUT_MS,
          signal: request.signal,
        }),
        this.#options.timeoutMs ?? SHIELD_MODEL_TIMEOUT_MS,
        request.signal,
      );
    } catch {
      outcome = { status: "failed" };
    }
    admission?.settle(outcome.status === "answered" ? outcome.usage : undefined);
    if (outcome.status !== "answered") {
      return decide(
        "ask",
        "fail-closed",
        outcome.status === "timed-out"
          ? "Shield's model did not answer in time, so the person decides."
          : "Shield's model could not be reached, so the person decides.",
        {
          rule: outcome.status === "timed-out" ? "model-timeout" : "model-unreachable",
          model: model.model,
        },
      );
    }
    const answer = parseShieldModelAnswer(outcome.text);
    if (answer === undefined) {
      return decide(
        "ask",
        "fail-closed",
        "Shield's model gave no clear answer, so the person decides.",
        {
          rule: "model-malformed",
          model: model.model,
        },
      );
    }
    return decide(answer.verdict, "model", answer.reason, { model: model.model });
  }
}

function withTimeout(
  promise: Promise<ShieldModelOutcome>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ShieldModelOutcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
    const abort = () => resolve({ status: "unreached" });
    if (signal?.aborted === true) abort();
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error("Shield model call failed."));
      },
    );
  });
}
