import { useId } from "react";
import type {
  ThreadBoardPullRequestIdentity,
  ThreadBoardPullRequestSummaries,
} from "@octant/contracts";
import { pullRequestStateMark } from "../code/pullRequestState";
import { githubPullRequestUrl } from "../threadBoard/githubPullRequestUrl";
import { MoreHorizontal } from "../ui/icons";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantMenu } from "../ui/base/OctantMenu";

type Summary = ThreadBoardPullRequestSummaries["items"][number];

export interface EnvironmentThreadPullRequestsProps {
  /**
   * This thread's pull requests as the host's cached snapshot holds them.
   * Absent and empty draw nothing: the renderer never reads GitHub itself.
   */
  readonly summaries?: ThreadBoardPullRequestSummaries | undefined;
  /** Opens the pull request in the app. Absent leaves the rows as plain facts. */
  readonly onOpen?: ((identity: ThreadBoardPullRequestIdentity) => void) | undefined;
  /** Opens the pull request's page on GitHub. Absent hides the menu entry. */
  readonly onOpenOnGithub?: ((identity: ThreadBoardPullRequestIdentity) => void) | undefined;
}

/** How many pull requests the thread has had, shown or not. */
export function threadPullRequestCount(
  summaries: ThreadBoardPullRequestSummaries | undefined,
): number {
  return summaries === undefined ? 0 : summaries.items.length + summaries.hiddenCount;
}

function stateWord(summary: Summary): string | undefined {
  return summary.state === "unknown" ? undefined : pullRequestStateMark(summary.state).label;
}

/** Checks matter while a pull request can still merge; afterwards they are history. */
function checksWord(summary: Summary): string | undefined {
  if (summary.state !== "open" && summary.state !== "draft") return undefined;
  return summary.checks === "unknown" ? undefined : summary.checks;
}

function staleWord(summary: Summary): string | undefined {
  if (summary.freshness === "stale") return "Stale snapshot";
  if (summary.freshness === "unavailable") return "GitHub unavailable";
  return undefined;
}

function rowName(summary: Summary): string {
  const state = stateWord(summary)?.toLowerCase() ?? "status unknown";
  const checks = checksWord(summary);
  return [
    `Pull request ${String(summary.identity.number)}`,
    summary.title,
    state,
    ...(checks === undefined ? [] : [`checks ${checks}`]),
    ...(summary.readyToMerge ? ["ready to merge"] : []),
    ...(staleWord(summary) === undefined ? [] : [staleWord(summary)?.toLowerCase() ?? ""]),
  ].join(", ");
}

function rowMeta(summary: Summary): string {
  return [
    `${summary.identity.repositoryName} #${String(summary.identity.number)}`,
    stateWord(summary),
    summary.readyToMerge ? "Ready to merge" : undefined,
    staleWord(summary),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard in this window: the link stays reachable through Open on GitHub.
  }
}

/**
 * The thread's own pull requests over its life (open, draft, merged, closed),
 * one two-line row each, inside the Changes section so the delivery history
 * sits beside the changes it came from. The Delivery section's Pull requests
 * group is the Project's open list; this is only what this thread produced.
 */
export function EnvironmentThreadPullRequests(props: EnvironmentThreadPullRequestsProps) {
  const captionId = useId();
  const summaries = props.summaries;
  if (summaries === undefined || summaries.items.length === 0) return null;
  return (
    <div aria-labelledby={captionId} className="environment-thread-prs" role="group">
      <p className="environment-card__caption" id={captionId}>
        Pull requests
      </p>
      <ul className="environment-thread-prs__list">
        {summaries.items.map((summary) => (
          <ThreadPullRequestRow
            key={`${String(summary.identity.projectId)}:${summary.identity.repositoryOwner}/${summary.identity.repositoryName}#${String(summary.identity.number)}`}
            onOpen={props.onOpen}
            onOpenOnGithub={props.onOpenOnGithub}
            summary={summary}
          />
        ))}
      </ul>
      {summaries.hiddenCount === 0 ? null : (
        <p className="environment-thread-prs__more">
          {`${String(summaries.hiddenCount)} more not shown`}
        </p>
      )}
    </div>
  );
}

function ThreadPullRequestRow(props: {
  readonly summary: Summary;
  readonly onOpen: EnvironmentThreadPullRequestsProps["onOpen"];
  readonly onOpenOnGithub: EnvironmentThreadPullRequestsProps["onOpenOnGithub"];
}) {
  const summary = props.summary;
  const number = String(summary.identity.number);
  const { Icon, tone } = pullRequestStateMark(summary.state);
  const checks = checksWord(summary);
  const url = githubPullRequestUrl(summary.identity);
  const openOnGithub = props.onOpenOnGithub;
  const onOpen = props.onOpen;
  const menu = [
    ...(openOnGithub === undefined || url === undefined
      ? []
      : [{ value: "github", label: "Open on GitHub" }]),
    ...(url === undefined ? [] : [{ value: "copy", label: "Copy link" }]),
  ];
  const content = (
    <>
      <span
        aria-hidden="true"
        className="environment-tile environment-thread-pr__state"
        data-pr-state={tone}
      >
        <Icon size={16} />
      </span>
      <span className="environment-thread-pr__text">
        <span className="environment-thread-pr__title">{summary.title}</span>
        <span className="environment-thread-pr__meta">{rowMeta(summary)}</span>
      </span>
      {checks === undefined ? null : (
        <span
          aria-hidden="true"
          className="environment-thread-pr__checks"
          data-checks={checks}
          title={`Checks ${checks}`}
        />
      )}
    </>
  );
  return (
    <li className="environment-thread-pr">
      {onOpen === undefined ? (
        <div aria-label={rowName(summary)} className="environment-thread-pr__open" role="group">
          {content}
        </div>
      ) : (
        <OctantButton
          aria-label={rowName(summary)}
          className="environment-link environment-thread-pr__open window-no-drag"
          onClick={() => onOpen(summary.identity)}
          title={summary.title}
          type="button"
          variant="bare"
        >
          {content}
        </OctantButton>
      )}
      {/* A sibling of the row, never inside it: a control inside a button is
          not reachable as its own control. It keeps its room at rest. */}
      <span className="environment-thread-pr__more">
        {menu.length === 0 ? null : (
          <OctantMenu
            items={menu}
            onValueChange={(value) => {
              if (value === "github") openOnGithub?.(summary.identity);
              else if (value === "copy" && url !== undefined) void copyText(url);
            }}
            selectionMode="action"
            trigger={<MoreHorizontal aria-hidden="true" size={16} />}
            triggerClassName="environment-menu-trigger"
            triggerLabel={`More for pull request #${number}`}
            value=""
          />
        )}
      </span>
    </li>
  );
}
