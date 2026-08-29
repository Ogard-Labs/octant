import type { GoalLoopClient, GoalLoopProjection } from "@octant/client-runtime/goal-loop-client";
import {
  decodeAggregateVersion,
  decodeGoalLoopId,
  type AgentRunAuthority,
  type GoalLoop,
  type ThreadGoal,
} from "@octant/contracts";
import { goalLoopBurnDown, goalLoopPauseText } from "@octant/domain";
import { useCallback, useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface GoalLoopPanelProps {
  readonly client?: GoalLoopClient;
  readonly threadId: string;
  /** The goal the loop works on; absent means there is nothing to loop over. */
  readonly goal: ThreadGoal | null;
}

const LIMIT_LABEL = {
  tokens: "tokens",
  time: "time",
  turns: "turns",
  none: "nothing",
} as const;

/**
 * What a loop is doing, and how to stop it.
 *
 * The two things a person needs while something works unattended are how much
 * of the budget is left and a way to end it. Both are here and neither is
 * behind a disclosure: a loop you cannot see the end of is a loop you cannot
 * supervise.
 *
 * Every control is a host command. Nothing renders as changed before the host
 * accepted it, and a refusal is shown in the host's own words rather than
 * re-derived here.
 */
export function GoalLoopPanel(props: GoalLoopPanelProps) {
  const { client, threadId } = props;
  const [projection, setProjection] = useState<GoalLoopProjection>({ loop: null, rounds: [] });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (client === undefined) return;
    try {
      setProjection(await client.read(threadId));
    } catch {
      setNotice("The loop could not be read.");
    }
  }, [client, threadId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loop = projection.loop;
  const goal = props.goal;
  if (client === undefined || goal === null) return null;

  const run = async (command: Parameters<GoalLoopClient["execute"]>[0]) => {
    setBusy(true);
    try {
      const result = await client.execute(command);
      if (result.kind === "goal-loop-refused") {
        setNotice(result.message);
        return;
      }
      setNotice(undefined);
      setProjection({ loop: result.loop, rounds: result.rounds });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The loop command failed.");
    } finally {
      setBusy(false);
    }
  };

  if (loop === null) {
    return (
      <section aria-label="Goal loop" className="goal-loop">
        <h4 className="goal-loop__title">Work on this on its own</h4>
        <p className="goal-loop__note">
          Each round is an ordinary turn in this thread, checkpointed first. It stops at the budget,
          at any approval, and if this thread&rsquo;s access widens.
        </p>
        <OctantButton
          disabled={busy}
          onClick={() =>
            void run({
              kind: "start-goal-loop",
              threadId,
              expectedVersion: decodeAggregateVersion(0),
              loopId: decodeGoalLoopId(crypto.randomUUID()),
              goalId: goal.id,
              ceiling: LOOP_CEILING,
              trigger: { kind: "continuous" },
            })
          }
          type="button"
          variant="secondary"
        >
          Start loop
        </OctantButton>
        {notice === undefined ? null : (
          <p className="goal-loop__notice" role="status">
            {notice}
          </p>
        )}
      </section>
    );
  }

  const burn = goalLoopBurnDown(goal.budget, goal.usage);
  const percent = Math.round(burn.fractionSpent * 100);

  return (
    <section aria-label="Goal loop" className="goal-loop">
      <h4 className="goal-loop__title">Loop</h4>
      <p className="goal-loop__state" data-status={loop.status}>
        <span className="goal-loop__status">{statusLabel(loop)}</span>
        <span className="goal-loop__rounds">
          {loop.roundsRun === 1 ? "1 round" : `${String(loop.roundsRun)} rounds`}
        </span>
      </p>

      <p className="goal-loop__burn">
        <span
          aria-label={`Budget spent: ${String(percent)} percent`}
          className="goal-loop__burn-bar"
          role="img"
        >
          <span className="goal-loop__burn-fill" style={{ inlineSize: `${String(percent)}%` }} />
        </span>
        <span className="goal-loop__burn-text">
          {burn.limiting === "none"
            ? "No budget set"
            : `${String(percent)}% of ${LIMIT_LABEL[burn.limiting]} spent`}
        </span>
      </p>

      {loop.pauseReason === undefined ? null : (
        <p className="goal-loop__reason" role="status">
          {goalLoopPauseText(loop.pauseReason)}
        </p>
      )}

      <div className="goal-loop__actions">
        {loop.status === "running" ? (
          <OctantButton
            disabled={busy}
            onClick={() =>
              void run({ kind: "pause-goal-loop", threadId, expectedVersion: loop.version })
            }
            type="button"
            variant="secondary"
          >
            Pause
          </OctantButton>
        ) : loop.status === "stopped" || loop.status === "complete" ? null : (
          <OctantButton
            disabled={busy}
            onClick={() =>
              void run({ kind: "resume-goal-loop", threadId, expectedVersion: loop.version })
            }
            type="button"
            variant="secondary"
          >
            Resume
          </OctantButton>
        )}
        {loop.status === "stopped" || loop.status === "complete" ? null : (
          <OctantButton
            disabled={busy}
            onClick={() =>
              void run({ kind: "stop-goal-loop", threadId, expectedVersion: loop.version })
            }
            type="button"
            variant="ghost"
          >
            Stop
          </OctantButton>
        )}
        {loop.status === "stopped" || loop.status === "complete" ? null : (
          <OctantButton
            disabled={busy || loop.ceiling.tools === false}
            onClick={() =>
              void run({
                kind: "narrow-goal-loop-ceiling",
                threadId,
                expectedVersion: loop.version,
                ceiling: { ...loop.ceiling, tools: false },
              })
            }
            type="button"
            variant="ghost"
          >
            Withhold tools
          </OctantButton>
        )}
      </div>

      {notice === undefined ? null : (
        <p className="goal-loop__notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

/**
 * The ceiling an unattended loop starts under.
 *
 * Work already denies shell, Git, and reach outside the Project, so this
 * declares exactly that and nothing more. A ceiling asking for less than the
 * mode fixes is refused by the host rather than quietly ignored, which is why
 * this matches rather than under-states it.
 */
const LOOP_CEILING: AgentRunAuthority = {
  filesystem: true,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
};

function statusLabel(loop: GoalLoop): string {
  switch (loop.status) {
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "awaiting-approval":
      return "Waiting for an approval";
    case "budget-limited":
      return "Budget spent";
    case "stopped":
      return "Stopped";
    case "complete":
      return "Complete";
  }
}
