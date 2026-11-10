import { useEffect, useState } from "react";
import type { GoalClient } from "@octant/client-runtime/goal-client";
import type { GoalLoopClient } from "@octant/client-runtime/goal-loop-client";
import type { ThreadGoalBudget } from "@octant/contracts";
import { AlertTriangle, CloudOff, Loader, ShieldAlert, Target } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { GoalCard } from "./GoalCard";
import { GoalLoopPanel } from "./GoalLoopPanel";
import { useGoalController, type GoalStatus } from "./useGoalController";

/**
 * How often an open panel re-reads a goal that is still active. A goal loop
 * records check outcomes and completes the goal in the background, so a panel
 * left open would otherwise keep showing the evidence it first loaded.
 */
export const GOAL_REFRESH_INTERVAL_MS = 10_000;

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
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft>(EMPTY_BUDGET_DRAFT);
  /** The budget as it was when Revise opened; the draft is compared with this, not the live goal. */
  const [budgetOpened, setBudgetOpened] = useState<ThreadGoalBudget>({});

  const goal = controller.goal;
  const { pending, reload } = controller;
  const refreshing = goal?.status === "active" && !pending;
  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") reload();
    }, GOAL_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshing, reload]);

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
              setBudgetDraft(budgetDraftFrom(goal.budget));
              setBudgetOpened(goal.budget);
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
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = revision.trim();
                const budget = budgetFromDraft(budgetDraft, budgetOpened);
                if (trimmed === "" || budget.kind === "invalid") return;
                const saved =
                  budget.kind === "unchanged"
                    ? controller.revise(trimmed)
                    : controller.revise(trimmed, budget.budget);
                void saved.then((accepted) => {
                  if (accepted) setRevising(false);
                });
              }}
            >
              <OctantInput
                aria-label="Revised objective"
                onChange={(event) => setRevision(event.target.value)}
                value={revision}
              />
              <fieldset className="thread-goal__budget">
                <legend>Budget</legend>
                <p className="thread-goal__budget-note" role="note">
                  A loop stops at the first limit it reaches. Leave a field empty for no limit of
                  that kind; a loop needs at least one.
                </p>
                <label className="thread-goal__budget-field">
                  <span>Turns</span>
                  <OctantInput
                    inputMode="numeric"
                    onChange={(event) =>
                      setBudgetDraft({ ...budgetDraft, turns: event.target.value })
                    }
                    value={budgetDraft.turns}
                  />
                </label>
                <label className="thread-goal__budget-field">
                  <span>Minutes</span>
                  <OctantInput
                    inputMode="numeric"
                    onChange={(event) =>
                      setBudgetDraft({ ...budgetDraft, minutes: event.target.value })
                    }
                    value={budgetDraft.minutes}
                  />
                </label>
                <label className="thread-goal__budget-field">
                  <span>Tokens</span>
                  <OctantInput
                    inputMode="numeric"
                    onChange={(event) =>
                      setBudgetDraft({ ...budgetDraft, tokens: event.target.value })
                    }
                    value={budgetDraft.tokens}
                  />
                </label>
              </fieldset>
              {budgetFromDraft(budgetDraft, budgetOpened).kind === "invalid" ? (
                /* ui-boundary-exception: inline-field-error */
                <p className="thread-goal__command-error" role="alert">
                  <AlertTriangle aria-hidden="true" size={14} strokeWidth={1.8} />
                  <span>Each budget must be a whole number above zero, or empty.</span>
                </p>
              ) : null}
              <OctantButton
                disabled={
                  controller.pending ||
                  revision.trim() === "" ||
                  budgetFromDraft(budgetDraft, budgetOpened).kind === "invalid"
                }
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
          noValidate
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
        /* ui-boundary-exception: inline-field-error */
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

interface BudgetDraft {
  readonly turns: string;
  readonly minutes: string;
  readonly tokens: string;
}

const EMPTY_BUDGET_DRAFT: BudgetDraft = { turns: "", minutes: "", tokens: "" };
const MS_PER_MINUTE = 60_000;

function budgetDraftFrom(budget: ThreadGoalBudget): BudgetDraft {
  return {
    turns: budget.turnBudget === undefined ? "" : String(budget.turnBudget),
    minutes:
      budget.timeBudgetMs === undefined
        ? ""
        : String(Math.ceil(budget.timeBudgetMs / MS_PER_MINUTE)),
    tokens: budget.tokenBudget === undefined ? "" : String(budget.tokenBudget),
  };
}

type ParsedLimit =
  | { readonly kind: "none" }
  | { readonly kind: "set"; readonly value: number }
  | { readonly kind: "invalid" };

function parseLimit(text: string): ParsedLimit {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "none" };
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" };
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? { kind: "set", value } : { kind: "invalid" };
}

/**
 * The budget a revision sends, replacing the goal's whole budget.
 *
 * An untouched draft sends nothing, so the host keeps the budget it holds: the
 * panel re-reads an active goal every ten seconds, and a budget another window
 * lowered meanwhile would otherwise be replaced by this form's stale copy under
 * the refreshed version, with no conflict reported. Minutes are shown rounded
 * up, so a time limit the person left as shown keeps its exact stored value.
 */
function budgetFromDraft(
  draft: BudgetDraft,
  opened: ThreadGoalBudget,
):
  | { readonly kind: "unchanged" }
  | { readonly kind: "valid"; readonly budget: ThreadGoalBudget }
  | { readonly kind: "invalid" } {
  const turns = parseLimit(draft.turns);
  const minutes = parseLimit(draft.minutes);
  const tokens = parseLimit(draft.tokens);
  if (turns.kind === "invalid" || minutes.kind === "invalid" || tokens.kind === "invalid") {
    return { kind: "invalid" };
  }
  const shown = budgetDraftFrom(opened);
  if (
    draft.turns === shown.turns &&
    draft.minutes === shown.minutes &&
    draft.tokens === shown.tokens
  ) {
    return { kind: "unchanged" };
  }
  const timeUnchanged = opened.timeBudgetMs !== undefined && draft.minutes === shown.minutes;
  const timeBudgetMs =
    minutes.kind === "none"
      ? undefined
      : timeUnchanged
        ? opened.timeBudgetMs
        : minutes.value * MS_PER_MINUTE;
  return {
    kind: "valid",
    budget: {
      ...(turns.kind === "set" ? { turnBudget: turns.value } : {}),
      ...(timeBudgetMs === undefined ? {} : { timeBudgetMs }),
      ...(tokens.kind === "set" ? { tokenBudget: tokens.value } : {}),
    },
  };
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
