import {
  decodeNativeHarnessAdvisorIntervention,
  decodeNativeHarnessContextReduction,
  decodeNativeHarnessTurnId,
  decodeNativeHarnessTurnRecord,
  decodeProviderSessionId,
  decodeUtcTimestamp,
  type ContextSubjectRef,
  type NativeHarnessSlotCandidate,
  type OctantMode,
  type ProjectId,
  type ProviderContextBlock,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { ContextHarnessService } from "../context/contextHarnessService";
import { parseNativeHarnessFollowUps } from "./nativeHarnessFollowUps";
import { nativeHarnessInstructions } from "./nativeHarnessInstructions";
import type { NativeHarnessRouter } from "./nativeHarnessRouter";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";
import { completeOnce } from "./nativeHarnessSingleShot";

const ADVISOR_TIMEOUT_MS = 60_000;
const MAX_DIGEST_CHARACTERS = 2_048;

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
  readonly uuid: () => string;
  readonly clock: () => string;
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
 * the context, records the turn and its follow-ups on the session, journals
 * the context reductions the planner made, and asks the advisor slot to
 * review a digest of the turn. The advisor's answer can redirect the next
 * turn or pause the run; it can never touch the world.
 */
export class NativeHarnessTurnObserver {
  readonly #options: NativeHarnessTurnObserverOptions;
  readonly #redirects = new Map<string, string>();

  constructor(options: NativeHarnessTurnObserverOptions) {
    this.#options = options;
  }

  contextFor(scope: NativeHarnessTurnScope): ReadonlyArray<ProviderContextBlock> {
    if (!this.#options.isHarnessProvider(scope.providerInstanceId)) return [];
    const redirect = this.#redirects.get(scope.threadId);
    this.#redirects.delete(scope.threadId);
    return [
      ...nativeHarnessInstructions(scope.mode),
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

  turnStarted(scope: NativeHarnessTurnScope): void {
    if (!this.#options.isHarnessProvider(scope.providerInstanceId)) return;
    this.#options.sessions.ensure({
      threadId: scope.threadId,
      mode: scope.mode,
      projectId: scope.projectId,
      leadSlotId: "default" as never,
      lead: this.#lead(scope),
    });
    this.#options.sessions.markRunning(scope.threadId);
  }

  async turnCompleted(
    input: NativeHarnessTurnScope & {
      readonly text: string;
      readonly toolCalls: number;
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
      readonly contextSubject?: ContextSubjectRef | undefined;
      readonly startedAt?: string | undefined;
    },
  ): Promise<void> {
    if (!this.#options.isHarnessProvider(input.providerInstanceId)) return;
    const session = this.#options.sessions.ensure({
      threadId: input.threadId,
      mode: input.mode,
      projectId: input.projectId,
      leadSlotId: "default" as never,
      lead: this.#lead(input),
    });
    const now = this.#options.clock();
    const turnId = decodeNativeHarnessTurnId(this.#options.uuid());
    const lead = this.#lead(input);
    try {
      this.#options.sessions.recordTurn(
        input.threadId,
        decodeNativeHarnessTurnRecord({
          turnId,
          sessionId: session.id,
          sequence: session.turnsRun + 1,
          job: "lead",
          route: {
            kind: "primary",
            job: "lead",
            slotId: session.leadSlotId,
            candidate: lead,
            decidedAt: now,
            rejected: [],
          },
          toolCalls: input.toolCalls,
          stopReason: "end-of-turn",
          usage: {
            inputTokens: input.usage?.inputTokens ?? 0,
            outputTokens: input.usage?.outputTokens ?? 0,
          },
          startedAt: input.startedAt ?? now,
          endedAt: now,
        }),
      );
    } catch {
      // A turn the journal refused still completed for the user; nothing else
      // here depends on the record existing.
    }
    const followUps = parseNativeHarnessFollowUps({
      text: input.text,
      turnId,
      uuid: this.#options.uuid,
    });
    if (followUps !== undefined) this.#options.sessions.recordFollowUps(input.threadId, followUps);
    if (input.contextSubject !== undefined)
      this.#recordReductions(input.threadId, turnId, input.contextSubject);
    await this.#review(input, turnId);
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
