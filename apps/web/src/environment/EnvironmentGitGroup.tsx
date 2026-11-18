import type { CodeEnvironmentObservation } from "@octant/contracts";
import { FileDiff, Files, GitBranch, Plus, TriangleAlert } from "../ui/icons";
import type { Ref } from "react";
import type { CodeEnvironmentControllerStatus } from "./useCodeEnvironmentController";
import { OctantAlert } from "../ui/base/OctantAlert";
import { EnvironmentRow } from "./EnvironmentGroup";

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
  /** The failure block, so a parent can hand it the keyboard when a re-read fails. */
  readonly failureRef?: Ref<HTMLDivElement>;
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
      <div className="environment-git-group__state" role="status">
        <EnvironmentRow icon={FileDiff} label="Loading repository…" muted />
      </div>
    );
  }
  if (props.status !== "ready" || props.observation === undefined) {
    const full = reason ?? "Repository environment is unavailable.";
    return (
      <div className="environment-git-group__state" ref={props.failureRef} tabIndex={-1}>
        <UnavailableRow reason={full} />
        <WayOut {...(props.action === undefined ? {} : { action: props.action })} />
      </div>
    );
  }
  if (props.observation.status !== "ready") {
    return (
      <div className="environment-git-group__state">
        <UnavailableRow reason={props.observation.reason} />
        <WayOut {...(props.action === undefined ? {} : { action: props.action })} />
      </div>
    );
  }
  const observation = props.observation;
  // A thread bound to the checkout itself worktrees nowhere; only a checkout
  // that really is somewhere else is worth a line.
  const separateWorktree = observation.worktreeRoot !== observation.repositoryRoot;
  const changesLabel =
    observation.changes === "clean" ? "No uncommitted changes" : "Uncommitted changes";
  const changesRow = (
    <EnvironmentRow
      {...(props.onOpenChanges === undefined || observation.changes === "clean"
        ? {}
        : { ariaLabel: "View changes", onClick: props.onOpenChanges })}
      detail={<ChangeCount observation={observation} />}
      icon={FileDiff}
      label={changesLabel}
    />
  );

  return (
    <div className="environment-git-group">
      {changesRow}
      {observation.branch.kind === "named" ? null : (
        <EnvironmentRow
          detail={
            <span
              aria-label={`Full commit ${observation.branch.oid}`}
              className="environment-git-group__mono"
              title={observation.branch.oid}
            >
              {observation.branch.oid.slice(0, 12)}
            </span>
          }
          icon={GitBranch}
          label="Detached HEAD"
        />
      )}
      {separateWorktree ? (
        <EnvironmentRow
          detail={
            <span className="environment-git-group__mono">
              {shortPath(observation.worktreeRoot)}
            </span>
          }
          icon={Files}
          label="Worktree"
          title={observation.worktreeRoot}
        />
      ) : null}
    </div>
  );
}

/** One muted line with the warning glyph; the full reason is its tooltip and description. */
function UnavailableRow(props: { readonly reason: string }) {
  return (
    <>
      <EnvironmentRow
        icon={TriangleAlert}
        label="Repository unavailable"
        muted
        title={props.reason}
      />
      <OctantAlert className="visually-hidden" tone="danger">
        {props.reason}
      </OctantAlert>
    </>
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
      <span className="environment-git-group__insertions">{`+${insertions.toLocaleString("en")}`}</span>
      <span className="environment-git-group__deletions">{`\u2212${deletions.toLocaleString("en")}`}</span>
    </span>
  );
}

/** The last two folders of a path behind an ellipsis; the full path is the line's title. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function WayOut(props: {
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  if (props.action === undefined) return null;
  return <EnvironmentRow icon={Plus} label={props.action.label} onClick={props.action.onClick} />;
}
