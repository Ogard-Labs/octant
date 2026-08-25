import { useState } from "react";
import type { GoalClient } from "@octant/client-runtime/goal-client";
import type { GoalLoopClient } from "@octant/client-runtime/goal-loop-client";
import { AlertTriangle, CloudOff, Loader, ShieldAlert, Target } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { GoalCard } from "./GoalCard";
import { GoalLoopPanel } from "./GoalLoopPanel";
import { useGoalController, type GoalStatus } from "./useGoalController";

export interface ThreadGoalPanelProps {
  readonly client?: GoalClient;
  /** Absent on a host that serves no loops, which keeps the surface off entirely. */
  readonly loopClient?: GoalLoopClient;
  readonly threadId: string;
}

/**
 * Thread-scoped mount for the authoritative Goal card.
 *
 * Every transition is a host command; nothing is rendered as changed before the
 * host accepted it. Load and command outcomes are announced with an icon *and*
 * words so the distinction never depends on colour alone, and the retention
 * note states the durability the host actually provides: the journal-backed
 * store rebuilds every Goal by replay, so a Goal outlives a host restart.
 */
export function ThreadGoalPanel(props: ThreadGoalPanelProps) {
  const controller = useGoalController({
    client: props.client,
    enabled: props.client !== undefined,
    threadId: props.threadId,
  });
  const [objective, setObjective] = useState("");
  const [revising, setRevising] = useState(false);
  const [revision, setRevision] = useState("");

  const goal = controller.goal;

  if (controller.status !== "ready") {
    return (
      <section aria-label="Goal" className="thread-goal">
        <h3 className="thread-goal__title">Goal</h3>
        <StatusNote status={controller.status} />
        {controller.status === "loading" || controller.status === "idle" ? null : (
          <OctantButton onClick={controller.reload} type="button" variant="secondary">
            Retry
          </OctantButton>
        )}
      </section>
    );
  }

  return (
    <section aria-label="Goal" className="thread-goal">
      <h3 className="thread-goal__title">Goal</h3>
      {goal !== null ? (
        <>
          <GoalCard
            goal={goal}
            onPause={() => void controller.pause()}
            onResume={() => void controller.resume()}
            onComplete={() => void controller.complete()}
            onRevise={() => {
              setRevision(goal.objective);
              setRevising(true);
            }}
          />
          <GoalLoopPanel
            {...(props.loopClient === undefined ? {} : { client: props.loopClient })}
            goal={goal}
            threadId={props.threadId}
          />
          {revising ? (
            <form
              className="thread-goal__revise"
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = revision.trim();
                if (trimmed === "") return;
                void controller.revise(trimmed).then((accepted) => {
                  if (accepted) setRevising(false);
                });
              }}
            >
              <OctantInput
                aria-label="Revised objective"
                onChange={(event) => setRevision(event.target.value)}
                value={revision}
              />
              <OctantButton
                disabled={controller.pending || revision.trim() === ""}
                type="submit"
                variant="default"
              >
                Save revision
              </OctantButton>
              <OctantButton onClick={() => setRevising(false)} type="button" variant="ghost">
                Cancel
              </OctantButton>
            </form>
          ) : null}
          <p className="thread-goal__history" role="note">
            {controller.history.length} recorded revision
            {controller.history.length === 1 ? "" : "s"}.
          </p>
        </>
      ) : null}
      {/*
        A completed Goal keeps its card — the thread's record of what it
        finished — and the form returns beneath it. The host has always allowed
        this: the policy refuses only a second *non-complete* Goal, and the
        controller already sends the completed Goal's version. Rendering the
        form only for `null` was what stranded a thread on its first Goal.
      */}
      {goal === null || goal.status === "complete" ? (
        <form
          className="thread-goal__create"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = objective.trim();
            if (trimmed === "") return;
            void controller.create(trimmed).then((accepted) => {
              if (accepted) setObjective("");
            });
          }}
        >
          <p className="thread-goal__empty" role="note">
            <Target aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>
              {goal === null
                ? "No Goal is set for this thread."
                : "This Goal is complete. Set the next one when you are ready."}
            </span>
          </p>
          <OctantInput
            aria-label="Goal objective"
            onChange={(event) => setObjective(event.target.value)}
            placeholder="What should this thread finish?"
            value={objective}
          />
          <OctantButton
            disabled={controller.pending || objective.trim() === ""}
            type="submit"
            variant="default"
          >
            Set Goal
          </OctantButton>
        </form>
      ) : null}
      {controller.commandMessage === undefined ? null : (
        <p className="thread-goal__command-error" role="alert">
          <AlertTriangle aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>{controller.commandMessage}</span>
        </p>
      )}
      <p className="thread-goal__retention" role="note">
        The host records this Goal in its journal, so it survives a restart.
      </p>
    </section>
  );
}

const STATUS_COPY: Record<Exclude<GoalStatus, "ready">, string> = {
  idle: "Goals are unavailable in this window.",
  loading: "Loading the Goal…",
  unauthorized: "This window is not authorized to read the Goal.",
  unavailable: "The host Goal service is unavailable.",
  failure: "The Goal could not be loaded.",
};

function StatusNote(props: { readonly status: Exclude<GoalStatus, "ready"> }) {
  const Icon =
    props.status === "loading"
      ? Loader
      : props.status === "unauthorized"
        ? ShieldAlert
        : props.status === "unavailable"
          ? CloudOff
          : props.status === "failure"
            ? AlertTriangle
            : Target;
  return (
    <p className="thread-goal__status" data-status={props.status} role="status">
      <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
      <span>{STATUS_COPY[props.status]}</span>
    </p>
  );
}
