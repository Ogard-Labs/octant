import type { CodeEnvironmentObservation } from "@octant/contracts";
import { Files, FolderGit2, GitBranch, GitCommitHorizontal, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
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
  const content = gitContent(props.observation);

  return (
    <div className="environment-git-group">
      <dl>
        <GitRow icon={GitCommitHorizontal} label="Changes" value={content.changes} />
        <GitRow icon={Files} label="Local" value={content.local} />
        <GitRow icon={GitBranch} label="Branch" value={content.branch} />
        <GitRow icon={FolderGit2} label="Repository" value={content.repository} />
        <GitRow icon={Files} label="Worktree" value={content.worktree} />
      </dl>
    </div>
  );
}

function GitRow(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div className="environment-git-group__row">
      <dt>
        <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
        {props.label}
      </dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function gitContent(
  observation: Extract<CodeEnvironmentObservation, { readonly status: "ready" }>,
): {
  readonly changes: ReactNode;
  readonly local: ReactNode;
  readonly branch: ReactNode;
  readonly repository: ReactNode;
  readonly worktree: ReactNode;
} {
  return {
    changes: observation.changes === "dirty" ? "Dirty working tree" : "Clean working tree",
    local: (
      <PathIdentity
        path={observation.worktreeRoot}
        primary={pathBasename(observation.worktreeRoot)}
        testId="environment-worktree-value"
      />
    ),
    branch:
      observation.branch.kind === "named" ? (
        observation.branch.name
      ) : (
        <span className="environment-git-group__detached">
          <span>Detached HEAD</span>
          <span aria-label={`Full commit ${observation.branch.oid}`} title={observation.branch.oid}>
            {observation.branch.oid.slice(0, 12)}
          </span>
        </span>
      ),
    repository: (
      <PathIdentity
        path={observation.repositoryRoot}
        primary={observation.projectName}
        testId="environment-repository-value"
      />
    ),
    worktree: <span title={observation.worktreeRoot}>{observation.worktreeRoot}</span>,
  };
}

function PathIdentity(props: {
  readonly path: string;
  readonly primary: string;
  readonly testId: string;
}) {
  return (
    <span className="environment-git-group__path" data-testid={props.testId} title={props.path}>
      <span className="environment-git-group__identity-primary">{props.primary}</span>
      <span className="environment-git-group__identity-secondary">{props.path}</span>
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
