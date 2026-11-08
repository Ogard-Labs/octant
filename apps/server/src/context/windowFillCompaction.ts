import type { ContextCompactionRecord, ContextSubjectRef, WindowId } from "@octant/contracts";
import { decideWindowFillCompaction } from "@octant/domain/context-compaction";
import { automaticCompactionId } from "./automaticCompaction";
import type { SessionCompactionService } from "./sessionCompaction";

/**
 * How often, and how far apart, a rule asks again while the turn that crossed
 * it is still settling. A turn's end is announced before every runtime has let
 * go of the thread, so the first ask can meet `turn-running`.
 */
const TURN_SETTLE_RETRIES = 3;
const TURN_SETTLE_RETRY_MS = 500;

export interface WindowFillRules {
  /** For threads Octant keeps: Octant Harness, and Chat and Work on a direct endpoint. */
  readonly octant: number | null;
  /** For threads a runtime keeps, which also compact by themselves. */
  readonly runtime: number | null;
}

export interface WindowFillCompactionOptions {
  readonly compactions: Pick<SessionCompactionService, "start" | "windowFill">;
  readonly latestCompaction: (subject: ContextSubjectRef) => ContextCompactionRecord | undefined;
  /** Read on every turn's end, so a change in Settings applies to the next one. */
  readonly rules: () => WindowFillRules;
  readonly schedule?: (run: () => void, delayMs: number) => void;
}

/**
 * Compacts a thread after a turn leaves its window at or past the share the
 * person set, so the next turn starts from a summary rather than from a
 * window the runtime or the planner would otherwise trim or overrun.
 *
 * It asks through the same service a window's **Compact session** does, as
 * `host-policy`, so every refusal a requested compaction meets applies; a
 * refused rule leaves nothing behind. A Code thread is compacted only under
 * the window whose turn crossed the rule, because its session runs in the
 * checkout that window resolved.
 */
export class WindowFillCompactions {
  readonly #options: WindowFillCompactionOptions;

  constructor(options: WindowFillCompactionOptions) {
    this.#options = options;
  }

  /**
   * `turnKey` names the turn that ended, so the same end announced twice is
   * one compaction.
   */
  turnEnded(input: {
    readonly subject: ContextSubjectRef;
    readonly turnKey: string;
    readonly windowId?: WindowId | undefined;
  }): void {
    const schedule = this.#options.schedule ?? ((run, delayMs) => void setTimeout(run, delayMs));
    const attempt = (remaining: number) => {
      let retry = false;
      try {
        retry = this.#attempt(input) === "turn-running" && remaining > 0;
      } catch {
        // A rule that could not judge the thread leaves it as it was; the
        // person can still compact it from the context popover.
      }
      if (retry) schedule(() => attempt(remaining - 1), TURN_SETTLE_RETRY_MS);
    };
    schedule(() => attempt(TURN_SETTLE_RETRIES), 0);
  }

  #attempt(input: {
    readonly subject: ContextSubjectRef;
    readonly turnKey: string;
    readonly windowId?: WindowId | undefined;
  }): "started" | "skipped" | "turn-running" {
    const fill = this.#options.compactions.windowFill(input.subject);
    if (fill === undefined) return "skipped";
    const rules = this.#options.rules();
    const previousAttempt = leftByLastRule(
      this.#options.latestCompaction(input.subject),
      fill.contextWindow,
    );
    const cause = decideWindowFillCompaction({
      thresholdPercent: fill.keeper === "octant" ? rules.octant : rules.runtime,
      tokens: fill.tokens,
      contextWindow: fill.contextWindow,
      ...(previousAttempt === undefined ? {} : { previousAttempt }),
    });
    if (cause === undefined) return "skipped";
    const result = this.#options.compactions.start(
      {
        kind: "compact-session",
        subject: input.subject,
        compactionId: automaticCompactionId(input.subject, `rule:window-fill:${input.turnKey}`, 1),
      },
      "host-policy",
      input.windowId,
      cause,
    );
    if (result.kind !== "compaction-refused") return "started";
    return result.reason === "turn-running" ? "turn-running" : "skipped";
  }
}

/**
 * Where the thread's latest rule compaction left its window: the figure after
 * a completed one, or the fill a failed or running one started from. A
 * compaction the person asked for, or a runtime's own, is no rule's attempt.
 */
function leftByLastRule(
  latest: ContextCompactionRecord | undefined,
  contextWindow: number | undefined,
): { readonly leftPercent: number } | undefined {
  if (latest === undefined) return undefined;
  if (latest.status !== "completed") {
    return latest.cause?.kind === "window-fill"
      ? { leftPercent: latest.cause.filledPercent }
      : undefined;
  }
  const { receipt } = latest;
  if (receipt.cause?.kind !== "window-fill") return undefined;
  if (receipt.tokensAfter.kind !== "known" || contextWindow === undefined || contextWindow <= 0) {
    return undefined;
  }
  return { leftPercent: Math.floor((receipt.tokensAfter.tokens * 100) / contextWindow) };
}
