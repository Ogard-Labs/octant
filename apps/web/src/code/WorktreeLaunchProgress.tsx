import "../styles/worktree-launch.css";
import { createContext, useContext, useEffect, useState } from "react";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type { CodeThreadId, CodeWorktreeCreationProgress } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import type { WorktreePreparation } from "@octant/contracts/project-terminals";
import type { PreparationTarget } from "../projects/WorktreePreparationDialog";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";
import { Check, Circle, GitFork, LoaderCircle, Minus, X } from "../ui/icons";

export interface WorktreeLaunch {
  readonly threadId: CodeThreadId;
  readonly composerId: string;
  readonly projectId: ProjectId;
  readonly startFromOrigin: boolean;
  readonly phase?: CodeWorktreeCreationProgress["phase"];
  readonly sourceMs?: number;
  readonly checkoutMs?: number;
  readonly target?: PreparationTarget;
  readonly turn?: "starting" | "started";
  readonly blocked?: boolean;
}

export const WorktreeLaunchContext = createContext<
  | {
      readonly launches: ReadonlyMap<CodeThreadId, WorktreeLaunch>;
      readonly client: ProjectTerminalClient;
      readonly onDetails: (target: PreparationTarget) => void;
      readonly detailsThreadId: CodeThreadId | undefined;
    }
  | undefined
>(undefined);

type StepStatus =
  | "Pending"
  | "Running"
  | "Done"
  | "Skipped"
  | "Cancelled"
  | "Interrupted"
  | "Failed"
  | "Unavailable";

const STEP_ICON = {
  Pending: Circle,
  Running: LoaderCircle,
  Done: Check,
  Skipped: Minus,
  Cancelled: Minus,
  Interrupted: X,
  Failed: X,
  Unavailable: Minus,
} satisfies Record<StepStatus, typeof Circle>;

function Step(props: {
  readonly label: string;
  readonly status: StepStatus;
  readonly ms?: number;
}) {
  const Icon = STEP_ICON[props.status];
  return (
    <li className="worktree-launch__step" data-state={props.status.toLowerCase()}>
      <Icon size={14} aria-hidden="true" />
      <span>{props.label}</span>
      <span className="worktree-launch__state">
        {props.ms === undefined
          ? props.status
          : `${props.status} · ${props.ms < 1000 ? `${props.ms} ms` : `${(props.ms / 1000).toFixed(1)} s`}`}
      </span>
    </li>
  );
}

type SetupRead =
  | { readonly kind: "unavailable" }
  | { readonly kind: "observed"; readonly preparation?: WorktreePreparation };

function setupStatus(read: SetupRead | undefined): StepStatus {
  if (read === undefined) return "Pending";
  if (read.kind === "unavailable") return "Unavailable";
  switch (read.preparation?.state) {
    case undefined:
    case "skipped":
      return "Skipped";
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "succeeded":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "cleanup-uncertain":
      return "Unavailable";
    case "failed":
      return "Failed";
  }
}

export function WorktreeLaunchProgress(props: {
  readonly launch: WorktreeLaunch;
  readonly firstMessageSent?: boolean;
}) {
  const context = useContext(WorktreeLaunchContext);
  const { launch } = props;
  const { target } = launch;
  const client = context?.client;
  const detailsOpen = context?.detailsThreadId === launch.threadId;
  const [setup, setSetup] = useState<SetupRead>();
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailure, setCancelFailure] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const started = launch.turn === "started" || props.firstMessageSent === true;
  const blocked = launch.blocked === true && !started;
  const waiting = launch.turn === "starting" && !started && !blocked;
  useEffect(() => {
    if (client === undefined || target === undefined || detailsOpen || cancelling) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inspect = async () => {
      try {
        const result = await client.execute(
          { kind: "worktree-preparation", ...target, action: "inspect" },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (result.kind === "worktree-preparation") {
          const preparation = result.preparation;
          setSetup({ kind: "observed", ...(preparation === undefined ? {} : { preparation }) });
          if (waiting && (preparation?.state === "pending" || preparation?.state === "running")) {
            timer = setTimeout(() => void inspect(), 1000);
          }
        } else {
          setSetup({ kind: "unavailable" });
          if (waiting) timer = setTimeout(() => void inspect(), 1000);
        }
      } catch {
        if (abort.signal.aborted) return;
        setSetup({ kind: "unavailable" });
        if (waiting) timer = setTimeout(() => void inspect(), 1000);
      }
    };
    void inspect();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [cancelling, client, detailsOpen, refresh, target, waiting]);

  const cancel = async () => {
    if (client === undefined || target === undefined || cancelling) return;
    setCancelling(true);
    setCancelFailure(false);
    try {
      const result = await client.execute({
        kind: "worktree-preparation",
        ...target,
        action: "cancel",
      });
      if (result.kind !== "worktree-preparation" || result.preparation === undefined) {
        setCancelFailure(true);
      } else {
        setSetup({ kind: "observed", preparation: result.preparation });
      }
    } catch {
      setCancelFailure(true);
    } finally {
      setCancelling(false);
      setRefresh((value) => value + 1);
    }
  };

  const ready = launch.phase === "ready";
  const source: StepStatus =
    ready || launch.phase === "checkout"
      ? "Done"
      : launch.phase === "source"
        ? blocked
          ? "Failed"
          : "Running"
        : "Pending";
  const checkout: StepStatus = ready
    ? "Done"
    : launch.phase === "checkout"
      ? blocked
        ? "Failed"
        : "Running"
      : "Pending";
  const recipe = setup?.kind === "observed" ? setup.preparation : undefined;
  const recipeStatus = setupStatus(setup);
  const recipeMs =
    recipe?.startedAt !== undefined && recipe.completedAt !== undefined
      ? Math.max(0, Date.parse(recipe.completedAt) - Date.parse(recipe.startedAt))
      : undefined;
  const agent: StepStatus = started
    ? "Done"
    : blocked
      ? ready && (recipeStatus === "Done" || recipeStatus === "Skipped")
        ? "Failed"
        : "Pending"
      : waiting && (recipeStatus === "Done" || recipeStatus === "Skipped")
        ? "Running"
        : "Pending";
  const recipeHeading =
    recipeStatus === "Cancelled"
      ? "Worktree setup cancelled"
      : recipeStatus === "Failed"
        ? "Worktree setup failed"
        : recipeStatus === "Interrupted"
          ? "Worktree setup interrupted"
          : undefined;
  const heading = started
    ? "Worktree ready"
    : (recipeHeading ??
      (blocked
        ? ready
          ? "Agent startup paused"
          : "Worktree setup incomplete"
        : "Setting up worktree"));
  return (
    <OctantCollapsible
      className="worktree-launch"
      chevron="end"
      open={!started}
      summaryClassName="worktree-launch__summary"
      summary={
        <>
          <GitFork aria-hidden="true" size={16} />
          <span role="status">{heading}</span>
        </>
      }
    >
      <ol aria-label="Worktree setup stages">
        <Step
          label={launch.startFromOrigin ? "Fetch base branch" : "Resolve local base"}
          status={source}
          {...(launch.sourceMs === undefined ? {} : { ms: launch.sourceMs })}
        />
        <Step
          label="Check out files"
          status={checkout}
          {...(launch.checkoutMs === undefined ? {} : { ms: launch.checkoutMs })}
        />
        <Step
          label="Run project setup"
          status={recipeStatus}
          {...(recipeMs === undefined ? {} : { ms: recipeMs })}
        />
        <Step label="Start agent" status={agent} />
      </ol>
      {target === undefined || context === undefined ? null : (
        <div className="worktree-launch__actions">
          <OctantButton
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => context.onDetails(target)}
          >
            Setup details
          </OctantButton>
          {recipeStatus === "Running" ? (
            <OctantButton
              size="sm"
              type="button"
              variant="ghost"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              Cancel setup
            </OctantButton>
          ) : null}
        </div>
      )}
      {cancelFailure ? (
        <OctantAlert tone="warning">
          Could not confirm cancellation. Open Setup details to check.
        </OctantAlert>
      ) : null}
    </OctantCollapsible>
  );
}
