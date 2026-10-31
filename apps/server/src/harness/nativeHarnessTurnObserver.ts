import {
  decodeNativeHarnessAdvisorIntervention,
  decodeNativeHarnessContextReduction,
  decodeNativeHarnessTurnId,
  decodeNativeHarnessTurnRecord,
  decodeProviderSessionId,
  decodeUtcTimestamp,
  type HarnessRetryNotice,
  type ContextSubjectRef,
  type NativeHarnessSlotCandidate,
  type NativeHarnessTurnStopReason,
  type OctantMode,
  type ProjectId,
  type ProviderContextBlock,
  type ProviderInstanceId,
  type ProviderModelId,
  type ThreadGoal,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { ContextHarnessService } from "../context/contextHarnessService";
import { nativeHarnessGoalContext } from "./nativeHarnessGoal";
import { nativeHarnessInstructions } from "./nativeHarnessInstructions";
import { harnessStopReason, type TurnEndSummary } from "../metrics/turnEnd";
import type { NativeHarnessRouter } from "./nativeHarnessRouter";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";
import { completeOnce } from "./nativeHarnessSingleShot";

const ADVISOR_TIMEOUT_MS = 60_000;
const MAX_DIGEST_CHARACTERS = 2_048;

/** Whether a turn may start on the thread; a pause names who paused it and why. */
export type NativeHarnessTurnAdmission =
  | { readonly kind: "admitted" }
  | {
      readonly kind: "paused";
      readonly status: "paused-by-advisor" | "paused-by-user" | "recovery-required";
      readonly detail: string;
    };

export interface NativeHarnessTurnScope {
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly projectId?: ProjectId | undefined;
}

export interface NativeHarnessTurnObserverOptions {
  readonly sessions: NativeHarnessSessionStore;
  readonly router: Pick<NativeHarnessRouter, "resolve">;
  readonly isHarnessProvider: (providerInstanceId: ProviderInstanceId) => boolean;
  readonly resolveDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  readonly hostId: string;
  readonly scratchRoot: string;
  readonly contextHarness?: Pick<ContextHarnessService, "inspect">;
  /** The thread's goal, put in front of every turn while it is open. */
  readonly readGoal?: (threadId: string) => ThreadGoal | undefined;
  /**
   * What the agent reads about the person's registered servers in Work and
   * Code: aliases, users, profiles, and runbook notes framed as context that
   * grants nothing.
   */
  readonly serverContext?: () => string | undefined;
  readonly uuid: () => string;
  readonly clock: () => string;
}

interface CompletedHarnessResponse extends NativeHarnessTurnScope {
  readonly text: string;
  readonly toolCalls: number;
  readonly turn?: TurnEndSummary | undefined;
  readonly contextSubject?: ContextSubjectRef | undefined;
}

const ADVISOR_INSTRUCTIONS = [
  "You supervise a coding agent's session. You will receive a digest of its latest turn.",
  "Answer with exactly one JSON object and nothing else:",
  '{"action":"none"|"redirect"|"pause","reason":"why, in one sentence","instruction":"what the lead must do next (redirect only)"}',
  "Choose redirect when the lead is drifting from the user's request, looping, or about to do something risky without saying so.",
  "Choose pause when a person must decide before work continues (destructive change, spending, an ambiguous goal).",
  "Otherwise choose none. You cannot run tools, edit files, or approve anything.",
].join("\n");

/**
 * What the harness does around every lead turn on a provider it drives: it
 * puts the stable instructions (and any pending advisor redirect) in front of
 * the context, records the turn on the session, journals
 * the context reductions the planner made, and asks the advisor slot to
 * review a digest of the turn. The advisor's answer can redirect the next
 * turn or pause the run; it can never touch the world.
 */
export class NativeHarnessTurnObserver {
  readonly #options: NativeHarnessTurnObserverOptions;
  readonly #redirects = new Map<string, string>();
  readonly #completedResponses = new Map<string, CompletedHarnessResponse>();

  constructor(options: NativeHarnessTurnObserverOptions) {
    this.#options = options;
  }

  contextFor(scope: NativeHarnessTurnScope): ReadonlyArray<ProviderContextBlock> {
    if (!this.#options.isHarnessProvider(scope.providerInstanceId)) return [];
    const redirect = this.#redirects.get(scope.threadId);
    this.#redirects.delete(scope.threadId);
    const goal = this.#goalContext(scope.threadId);
    const servers = scope.mode === "chat" ? undefined : this.#serverContext();
    return [
      ...nativeHarnessInstructions(scope.mode),
      // Per-turn content, after the stable instructions, so the goal's
      // changing statuses never move the cached prefix.
      ...(goal === undefined ? [] : [{ kind: "work-item" as const, text: goal }]),
      ...(servers === undefined ? [] : [{ kind: "project-memory" as const, text: servers }]),
      ...(redirect === undefined
        ? []
        : [
            {
              kind: "instructions" as const,
              text: `The advisor reviewed your last turn and redirects you: ${redirect}`,
            },
          ]),
    ];
  }

  /**
   * A paused session refuses the next turn until a person resumes it. The
   * advisor pauses when someone must decide before work continues; letting
   * the next prompt through would make that decision by default. A session a
   * restart left needing recovery refuses the same way, so nothing picks up
   * after a restart until a person has looked.
   */
  admitTurn(scope: NativeHarnessTurnScope): NativeHarnessTurnAdmission {
    const session = this.#options.sessions.read(scope.threadId)?.session;
    if (
      session?.status === "paused-by-advisor" ||
      session?.status === "paused-by-user" ||
      session?.status === "recovery-required"
    ) {
      return {
        kind: "paused",
        status: session.status,
        detail:
          session.detail ??
          (session.status === "paused-by-advisor"
            ? "The advisor paused this run."
            : session.status === "recovery-required"
              ? "Octant restarted mid-run. Resume once you have checked the thread."
              : "Paused."),
      };
    }
    return { kind: "admitted" };
  }

  /**
   * A provider's completed response can still lose to cancellation or cleanup.
   * Record only at final settlement, with the runner's final usage and reason,
   * so that race cannot charge the native session for the same turn twice.
   */
  turnEnded(scope: NativeHarnessTurnScope, turn?: TurnEndSummary): void {
    const response = this.#completedResponses.get(scope.threadId);
    this.#completedResponses.delete(scope.threadId);
    const finalTurn = turn ?? response?.turn;
    if (finalTurn !== undefined || response !== undefined) {
      const turnId = decodeNativeHarnessTurnId(this.#options.uuid());
      this.#recordTurn(scope, {
        turnId,
        stopReason: harnessStopReason(finalTurn?.stopReason ?? "end-of-turn"),
        ...(response === undefined ? {} : { toolCalls: response.toolCalls }),
        ...(finalTurn === undefined ? {} : { turn: finalTurn }),
      });
      if (response !== undefined) {
        if (response.contextSubject !== undefined)
          this.#recordReductions(scope.threadId, turnId, response.contextSubject);
        if (
          finalTurn === undefined ||
          finalTurn.stopReason === "end-of-turn" ||
          finalTurn.stopReason === "max-tokens"
        ) {
          // Review cannot hold up settlement or run for a cancelled response.
          void this.#review(response, turnId).catch(() => undefined);
        }
      }
    }
    this.#options.sessions.settleTurn(scope.threadId);
    this.#options.sessions.clearRetry(scope.threadId);
  }

  turnStarted(scope: NativeHarnessTurnScope): void {
    this.#options.sessions.ensure({
      threadId: scope.threadId,
      mode: scope.mode,
      projectId: scope.projectId,
      leadSlotId: "default" as never,
      lead: this.#lead(scope),
    });
    this.#options.sessions.markRunning(scope.threadId);
    this.#options.sessions.clearRetry(scope.threadId);
  }

  noteRetry(scope: NativeHarnessTurnScope, notice: HarnessRetryNotice): void {
    if (!this.#options.isHarnessProvider(scope.providerInstanceId)) return;
    this.#options.sessions.noteRetry(scope.threadId, notice);
  }

  clearRetry(scope: NativeHarnessTurnScope): void {
    if (!this.#options.isHarnessProvider(scope.providerInstanceId)) return;
    this.#options.sessions.clearRetry(scope.threadId);
  }

  async turnCompleted(input: CompletedHarnessResponse): Promise<void> {
    if (!this.#options.isHarnessProvider(input.providerInstanceId)) return;
    // A note the lead already read is done; one still queued waits for the next prompt.
    this.#options.sessions.clearSteering(input.threadId, "delivered");
    this.#completedResponses.set(input.threadId, input);
  }

  /** The one place a turn becomes a journaled record, whether it finished or stopped early. */
  #recordTurn(
    scope: NativeHarnessTurnScope,
    outcome: {
      readonly turnId: string;
      readonly stopReason: NativeHarnessTurnStopReason;
      readonly toolCalls?: number;
      readonly turn?: TurnEndSummary;
    },
  ): void {
    const session = this.#options.sessions.ensure({
      threadId: scope.threadId,
      mode: scope.mode,
      projectId: scope.projectId,
      leadSlotId: "default" as never,
      lead: this.#lead(scope),
    });
    const now = this.#options.clock();
    const tools = this.#options.sessions.takeToolCalls(scope.threadId);
    try {
      this.#options.sessions.recordTurn(
        scope.threadId,
        decodeNativeHarnessTurnRecord({
          ...(tools.length === 0 ? {} : { tools }),
          turnId: outcome.turnId,
          sessionId: session.id,
          sequence: session.turnsRun + 1,
          job: "lead",
          route: {
            kind: "primary",
            job: "lead",
            slotId: session.leadSlotId,
            candidate: this.#lead(scope),
            decidedAt: now,
            rejected: [],
          },
          toolCalls: outcome.toolCalls ?? tools.length,
          stopReason: outcome.stopReason,
          usage: outcome.turn?.usage ?? { inputTokens: 0, outputTokens: 0 },
          ...(outcome.turn === undefined ? {} : { metrics: outcome.turn.metrics }),
          startedAt: outcome.turn?.startedAt ?? now,
          endedAt: outcome.turn?.endedAt ?? now,
        }),
      );
    } catch {
      // A turn the journal refused still ended for the user; nothing else
      // here depends on the record existing.
    }
  }

  #recordReductions(threadId: string, turnId: string, subject: ContextSubjectRef): void {
    const inspect = this.#options.contextHarness?.inspect;
    if (inspect === undefined) return;
    try {
      const snapshot = inspect(subject);
      const plan = snapshot.latestSent?.plan;
      if (plan === undefined) return;
      const omitted = plan.entries.filter((entry) => entry.state === "omitted").length;
      const truncated = plan.entries.filter((entry) => entry.state === "truncated").length;
      const base = {
        turnId,
        requiredTokens: Math.max(1, plan.plannedInputTokens),
        windowTokens: Math.max(1, plan.safeInputBudget),
        reducedAt: this.#options.clock(),
      };
      if (truncated > 0) {
        this.#options.sessions.recordReduction(
          threadId,
          decodeNativeHarnessContextReduction({
            ...base,
            kind: "prune",
            prunedToolResults: truncated,
            freedTokens: Math.max(1, truncated),
          }),
        );
      }
      if (omitted > 0) {
        this.#options.sessions.recordReduction(
          threadId,
          decodeNativeHarnessContextReduction({
            ...base,
            kind: "cutover",
            droppedTurns: omitted,
            boundary: "turn",
            cachePrefixInvalidated: true,
            carriedNotes: [],
            freedTokens: Math.max(1, omitted),
          }),
        );
      }
    } catch {
      // The planner's own record is authoritative; a snapshot that cannot be
      // read leaves the session view without a reduction entry.
    }
  }

  async #review(
    input: NativeHarnessTurnScope & { readonly text: string; readonly toolCalls: number },
    turnId: string,
  ): Promise<void> {
    const decision = this.#options.router.resolve({ job: "advisor", projectId: input.projectId });
    if (decision.kind === "unroutable") return;
    const driver = this.#options.resolveDriver(decision.candidate.providerInstanceId);
    if (driver === undefined) return;
    const digest = {
      turnId,
      summary: input.text.trim().slice(0, MAX_DIGEST_CHARACTERS) || "(no visible reply)",
      toolCalls: input.toolCalls,
      filesTouched: [],
    };
    const answer = await completeOnce({
      driver,
      providerInstanceId: decision.candidate.providerInstanceId,
      modelId: decision.candidate.modelId,
      sessionId: decodeProviderSessionId(this.#options.uuid()),
      projectRoot: this.#options.scratchRoot,
      instructions: ADVISOR_INSTRUCTIONS,
      prompt: `Mode: ${input.mode}\nTool calls this turn: ${digest.toolCalls}\nLead's reply:\n${digest.summary}`,
      timeoutMs: ADVISOR_TIMEOUT_MS,
    });
    const verdict = parseVerdict(answer);
    if (verdict === undefined || verdict.action === "none") return;
    const fields = {
      id: this.#options.uuid(),
      sessionId: this.#options.sessions.ensure({
        threadId: input.threadId,
        mode: input.mode,
        projectId: input.projectId,
        leadSlotId: "default" as never,
        lead: this.#lead(input),
      }).id,
      route: decision.candidate,
      occurredAt: decodeUtcTimestamp(this.#options.clock()),
    };
    try {
      if (verdict.action === "redirect") {
        this.#redirects.set(input.threadId, verdict.instruction);
        this.#options.sessions.recordIntervention(
          input.threadId,
          decodeNativeHarnessAdvisorIntervention({
            ...fields,
            kind: "redirect",
            instruction: verdict.instruction,
          }),
        );
      } else {
        this.#options.sessions.recordIntervention(
          input.threadId,
          decodeNativeHarnessAdvisorIntervention({
            ...fields,
            kind: "pause-run",
            reason: verdict.reason,
          }),
        );
      }
    } catch {
      // An answer the schema refuses is not an intervention.
    }
  }

  #serverContext(): string | undefined {
    try {
      return this.#options.serverContext?.();
    } catch {
      // Notes that cannot be read leave the turn without them; they never
      // gate one.
      return undefined;
    }
  }

  #goalContext(threadId: string): string | undefined {
    try {
      const goal = this.#options.readGoal?.(threadId);
      return goal === undefined ? undefined : nativeHarnessGoalContext(goal);
    } catch {
      // A goal that cannot be read leaves the turn without it rather than failing the turn.
      return undefined;
    }
  }

  #lead(scope: NativeHarnessTurnScope): NativeHarnessSlotCandidate {
    return {
      hostId: this.#options.hostId as never,
      providerInstanceId: scope.providerInstanceId,
      modelId: scope.modelId,
    };
  }
}

type AdvisorVerdict =
  | { readonly action: "none" }
  | { readonly action: "redirect"; readonly instruction: string; readonly reason: string }
  | { readonly action: "pause"; readonly reason: string };

/** The advisor's JSON object, from wherever in its reply it put it. */
export function parseVerdict(answer: string | undefined): AdvisorVerdict | undefined {
  if (answer === undefined) return undefined;
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 1_024) : "";
  if (record.action === "redirect") {
    const instruction =
      typeof record.instruction === "string" ? record.instruction.trim().slice(0, 4_096) : "";
    if (instruction.length === 0) return undefined;
    return { action: "redirect", instruction, reason: reason || instruction };
  }
  if (record.action === "pause") {
    return reason.length === 0 ? undefined : { action: "pause", reason };
  }
  return record.action === "none" ? { action: "none" } : undefined;
}
