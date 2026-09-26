import type { CodeEnvironmentObservation } from "@octant/contracts";
import { ChevronRight, FileDiff, Files, GitBranch } from "lucide-react";
import type { CodeEnvironmentControllerStatus } from "./useCodeEnvironmentController";
import { OctantButton } from "../ui/base/OctantButton";

export interface EnvironmentGitGroupProps {
  /**
   * A way out of an unusable checkout. A thread whose Project was rebound can
   * never observe its own checkout again, so the panel used to state that and
   * stop — a dead end with nothing to press.
   */
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
  readonly errorMessage?: string | undefined;
  readonly observation?: CodeEnvironmentObservation | undefined;
  readonly status: CodeEnvironmentControllerStatus;
  readonly onOpenChanges?: () => void;
}

export function EnvironmentGitGroup(props: EnvironmentGitGroupProps) {
  const reason =
    props.status === "error"
      ? (props.errorMessage ?? "Environment inspection is unavailable.")
      : props.observation?.status === "unavailable" || props.observation?.status === "failed"
        ? props.observation.reason
        : undefined;

  if (props.status === "loading") {
    return (
      <p className="environment-git-group__state" role="status">
        Loading repository environment…
      </p>
    );
  }
  if (props.status !== "ready" || props.observation === undefined) {
    return (
      <div className="environment-git-group__state">
        <p className="environment-git-group__error" role="alert">
          {reason ?? "Repository environment is unavailable."}
        </p>
        <WayOut {...(props.action === undefined ? {} : { action: props.action })} />
      </div>
    );
  }
  if (props.observation.status !== "ready") {
    return (
      <div className="environment-git-group__state">
        <strong>{props.observation.projectName}</strong>
        <p className="environment-git-group__error" role="alert">
          {props.observation.reason}
        </p>
        <WayOut {...(props.action === undefined ? {} : { action: props.action })} />
      </div>
    );
  }
  const observation = props.observation;
  // A thread bound to the checkout itself worktrees nowhere; only a checkout
  // that really is somewhere else is worth a line.
  const separateWorktree = observation.worktreeRoot !== observation.repositoryRoot;
  const changesLine = (
    <>
      <FileDiff aria-hidden="true" className="environment-git-group__icon" size={16} />
      <span className="environment-git-group__label">
        {observation.changes === "clean" ? "No uncommitted changes" : "Uncommitted changes"}
      </span>
      <ChangeCount observation={observation} />
    </>
  );

  // The name, branch and folder lead the Environment header, so this card
  // says only what the checkout holds and what to do about it. It had been a
  // four-row table whose Branch and Repository rows repeated that header.
  return (
    <div className="environment-git-group">
      {props.onOpenChanges === undefined || observation.changes === "clean" ? (
        <p className="environment-git-group__changes">{changesLine}</p>
      ) : (
        <OctantButton
          aria-label="View changes"
          className="environment-git-group__changes environment-changes-action"
          onClick={props.onOpenChanges}
          type="button"
          variant="ghost"
        >
          {changesLine}
          <ChevronRight
            aria-hidden="true"
            className="environment-git-group__chevron"
            size={14}
            strokeWidth={1.8}
          />
        </OctantButton>
      )}
      {observation.branch.kind === "named" ? null : (
        <p className="environment-git-group__fact">
          <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>Detached HEAD</span>
          <span
            aria-label={`Full commit ${observation.branch.oid}`}
            className="environment-git-group__mono"
            title={observation.branch.oid}
          >
            {observation.branch.oid.slice(0, 12)}
          </span>
        </p>
      )}
      {separateWorktree ? (
        <p className="environment-git-group__fact" title={observation.worktreeRoot}>
          <Files aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>Worktree</span>
          <span className="environment-git-group__mono">
            {pathBasename(observation.worktreeRoot)}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the working tree has changed, in the units a reader acts on.
 *
 * "Dirty working tree" says only that something is uncommitted; the totals say
 * whether that is a typo or a day's work. They are shown only when the host
 * measured them, so an unmeasured tree still reads honestly.
 */
function ChangeCount(props: {
  readonly observation: Extract<CodeEnvironmentObservation, { readonly status: "ready" }>;
}) {
  const { insertions, deletions } = props.observation;
  // The label beside the count already says clean or uncommitted.
  if (props.observation.changes === "clean") return null;
  if (insertions === undefined || deletions === undefined) return null;
  return (
    <span className="environment-git-group__diffstat">
      <span className="environment-git-group__insertions">{`+${insertions.toLocaleString()}`}</span>
      <span className="environment-git-group__deletions">{`\u2212${deletions.toLocaleString()}`}</span>
    </span>
  );
}

function pathBasename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function WayOut(props: {
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  if (props.action === undefined) return null;
  return (
    <OctantButton
      className="environment-group__action window-no-drag"
      onClick={props.action.onClick}
      type="button"
      variant="ghost"
    >
      {props.action.label}
    </OctantButton>
  );
}
