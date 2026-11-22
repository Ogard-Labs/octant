import "../styles/environment-details.css";
import { useId } from "react";
import type {
  ThreadBoardPullRequestIdentity,
  ThreadBoardPullRequestSummaries,
} from "@octant/contracts";
import { pullRequestStateMark } from "../code/pullRequestState";
import { githubPullRequestUrl } from "../threadBoard/githubPullRequestUrl";
import { GitMerge, MoreHorizontal } from "../ui/icons";
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

/**
 * An open pull request on its way in says so instead of "Open": "Merging" while
 * it sits in the merge queue, "Merges when ready" while auto-merge waits on its
 * requirements. Only an open one can be merging; a draft never is.
 */
function mergingWord(summary: Summary): string | undefined {
  if (summary.state !== "open") return undefined;
  if (summary.merging === "queued") return "Merging";
  if (summary.merging === "auto-merge") return "Merges when ready";
  return undefined;
}

function stateWord(summary: Summary): string | undefined {
  if (summary.state === "unknown") return undefined;
  return mergingWord(summary) ?? pullRequestStateMark(summary.state).label;
}

/**
 * The leading mark. A queued pull request takes the merge glyph in the pending
 * tone; every other state keeps the shared mark, auto-merge included, because
 * it is still an open pull request until it is in the queue.
 */
function leadingMark(summary: Summary) {
  if (summary.state === "open" && summary.merging === "queued") {
    return { Icon: GitMerge, tone: "queued" } as const;
  }
  return pullRequestStateMark(summary.state);
}

/** "19/26" while a pull request that can still merge has checks not yet passed. */
function checkCountWords(
  summary: Summary,
): { readonly short: string; readonly long: string } | undefined {
  if (checksWord(summary) === undefined) return undefined;
  const counts = summary.checkCounts;
  if (counts === undefined || counts.passed >= counts.total) return undefined;
  return {
    short: `${String(counts.passed)}/${String(counts.total)}`,
    long: `${String(counts.passed)} of ${String(counts.total)} passed`,
  };
}

function lineCounts(
  summary: Summary,
): { readonly added: string; readonly removed: string; readonly spoken: string } | undefined {
  if (summary.additions === undefined || summary.deletions === undefined) return undefined;
  const added = summary.additions.toLocaleString("en");
  const removed = summary.deletions.toLocaleString("en");
  return {
    added,
    removed,
    spoken: `${added} ${summary.additions === 1 ? "line" : "lines"} added, ${removed} removed`,
  };
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
  const counts = checkCountWords(summary);
  const lines = lineCounts(summary);
  return [
    `Pull request ${String(summary.identity.number)}`,
    summary.title,
    state,
    ...(checks === undefined ? [] : [`checks ${checks}`]),
    ...(counts === undefined ? [] : [`checks ${counts.long}`]),
    ...(lines === undefined ? [] : [lines.spoken]),
    ...(summary.readyToMerge ? ["ready to merge"] : []),
    ...(staleWord(summary) === undefined ? [] : [staleWord(summary)?.toLowerCase() ?? ""]),
  ].join(", ");
}

/**
 * Line two: the repository, which gives way first when the room is short, then
 * the number and words, then the line counts in the two inks the changes row
 * uses.
 */
function RowMeta(props: { readonly summary: Summary }) {
  const summary = props.summary;
  const words = [
    `#${String(summary.identity.number)}`,
    stateWord(summary),
    summary.readyToMerge ? "Ready to merge" : undefined,
    staleWord(summary),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" \u00b7 ");
  const lines = lineCounts(summary);
  return (
    <span className="environment-thread-pr__meta">
      <span className="environment-thread-pr__repository">{summary.identity.repositoryName}</span>{" "}
      <span className="environment-thread-pr__words">{words}</span>
      {lines === undefined ? null : (
        <>
          {" "}
          <span className="environment-thread-pr__diffstat">
            <span className="environment-thread-pr__insertions">{`+${lines.added}`}</span>{" "}
            <span className="environment-thread-pr__deletions">{`\u2212${lines.removed}`}</span>
          </span>
        </>
      )}
    </span>
  );
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
  const { Icon, tone } = leadingMark(summary);
  const checks = checksWord(summary);
  const counts = checkCountWords(summary);
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
        <RowMeta summary={summary} />
      </span>
      {/* A row that can show checks (open or draft) keeps one width at its end,
          with or without a count or a dot, so a count arriving moves nothing.
          A merged or closed row never shows either and keeps the room for its
          title. */}
      <span
        aria-hidden="true"
        className="environment-thread-pr__checks-end"
        data-reserved={summary.state === "open" || summary.state === "draft" ? "true" : undefined}
      >
        {counts === undefined ? null : (
          <span className="environment-thread-pr__check-count">{counts.short}</span>
        )}
        {checks === undefined ? null : (
          <span
            className="environment-thread-pr__checks"
            data-checks={checks}
            title={counts === undefined ? `Checks ${checks}` : `Checks ${checks}, ${counts.long}`}
          />
        )}
      </span>
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
