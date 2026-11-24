import "../styles/thread-row-info-card.css";
import type { ThreadBoardPullRequestSummaries } from "@octant/contracts";
import { pullRequestStateMark } from "../code/pullRequestState";
import { readableModelId } from "../providers/providerModelLabel";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { describePullRequestSummary } from "../threadBoard/ThreadBoardPullRequestSummaries";
import { githubPullRequestUrl } from "../threadBoard/githubPullRequestUrl";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { Cpu, ExternalLink, FolderGit2, GitBranch, GitFork } from "../ui/icons";
import type { IconComponent } from "../ui/icons";
import type { ThreadRowActions } from "./ThreadRowMenu";
import { pullRequestKey } from "./threadRowPullRequests";

/**
 * The states worth naming at the top of the card, most actionable first. A row
 * can hold several at once, so each is its own marker rather than a joined
 * phrase.
 */
function threadRowStates(thread: ChatThreadNavigationItem): ReadonlyArray<string> {
  const states: string[] = [];
  if (thread.followUp === true) states.push("Follow-up");
  if (thread.unread === true) states.push("Unread");
  if (thread.pinned === true) states.push("Pinned");
  if (thread.woke === true) states.push("Snooze ended");
  else if (thread.shelf === "snoozed") states.push("Snoozed");
  if (thread.shelf === "completed") states.push("Put away");
  return states;
}

function threadRowAge(updatedAt: string | undefined): string | undefined {
  if (updatedAt === undefined) return undefined;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days}d ago`;
  return date.toLocaleDateString();
}

/** One icon-and-label line of the info card. */
interface ThreadRowFact {
  readonly icon: IconComponent;
  readonly key: string;
  readonly label: string;
}

/**
 * Builds the card's fact rows from values already present in the navigation
 * item and Project context. It does not invent transcript detail, model names,
 * or turn counts; those are not in the row's contract.
 */
function threadRowFacts(props: {
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}): ReadonlyArray<ThreadRowFact> {
  const facts: ThreadRowFact[] = [];
  if (props.projectName !== undefined) {
    facts.push({ icon: FolderGit2, key: "project", label: props.projectName });
  }
  if (props.thread.checkoutChip !== undefined) {
    facts.push({ icon: GitBranch, key: "checkout", label: props.thread.checkoutChip.label });
  }
  // The model rides beside its provider ("Claude · Opus 5.5"). The card has
  // no model catalogue to ask, so it reads the id the way the composer does
  // for a model no catalogue described, without repeating the provider's name.
  const providerName = props.thread.provider?.displayName;
  const readable =
    props.thread.modelId === undefined ? undefined : readableModelId(props.thread.modelId);
  const model =
    readable !== undefined && providerName !== undefined && readable.startsWith(`${providerName} `)
      ? readable.slice(providerName.length + 1)
      : readable;
  const engine = [providerName, model].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  if (engine.length > 0) {
    facts.push({ icon: Cpu, key: "provider", label: engine.join(" · ") });
  }
  if (props.lineageParentTitle !== undefined) {
    facts.push({ icon: GitFork, key: "lineage", label: `Forked from ${props.lineageParentTitle}` });
  } else if (props.thread.lineageParentThreadId !== undefined) {
    facts.push({
      icon: GitFork,
      key: "lineage",
      label: "Forked from a thread no longer available",
    });
  }
  return facts;
}

type ThreadRowPullRequestSummary = ThreadBoardPullRequestSummaries["items"][number];

/** How a pull request's checks read beside its number, while it can still merge. */
function checksMark(summary: ThreadRowPullRequestSummary): string | undefined {
  if (summary.state !== "open" && summary.state !== "draft") return undefined;
  return summary.checks === "unknown" ? undefined : summary.checks;
}

/**
 * Every pull request the thread worked on, one line each, inside the card.
 *
 * A line is the state glyph in its colour, a checks dot while the pull request
 * can still merge, the number and the title; the remaining facts (checks,
 * review, conflicts, freshness) are in its tooltip and accessible name, so a
 * thread with dozens of pull requests still reads at a glance. The repository
 * is named only when the thread's pull requests span more than one.
 *
 * A click opens the pull request in Octant's Review dock; Cmd-click (Ctrl on
 * other platforms) and the trailing control go to github.com, so both
 * destinations stay one gesture apart. Without a Review route the reference
 * is plain text — a button that could open nothing would read as broken —
 * and without an external route neither the control nor the modifier is
 * offered. The facts come from the cached snapshot the row already carries;
 * nothing here asks GitHub for more.
 */
function ThreadRowPullRequests(props: {
  readonly actions: ThreadRowActions;
  readonly summaries: ThreadBoardPullRequestSummaries;
}) {
  const openInReview = props.actions.onOpenPullRequest;
  const openOnGithub = props.actions.onOpenPullRequestOnGithub;
  const repositories = new Set(
    props.summaries.items.map(
      (summary) => `${summary.identity.repositoryOwner}/${summary.identity.repositoryName}`,
    ),
  );
  const namesRepository = repositories.size > 1;
  return (
    <span aria-label="Linked pull requests" className="thread-row-info-card__prs" role="group">
      <span className="thread-row-info-card__pr-list">
        {props.summaries.items.map((summary) => {
          const number = String(summary.identity.number);
          const repo = `${summary.identity.repositoryOwner}/${summary.identity.repositoryName}`;
          const meta = [repo, ...describePullRequestSummary(summary)].join(" · ");
          const externalUrl =
            openOnGithub === undefined ? undefined : githubPullRequestUrl(summary.identity);
          const mark = pullRequestStateMark(summary.state);
          const checks = checksMark(summary);
          const reference = (
            <>
              <span className="thread-row-info-card__pr-state" data-pr-state={mark.tone}>
                <mark.Icon aria-hidden="true" size={14} />
              </span>
              {/* The dot's slot is kept on every line so numbers align down
                  the list whether or not a pull request still has checks. */}
              <span
                aria-hidden="true"
                className="thread-row-info-card__pr-checks"
                data-checks={checks ?? "none"}
              />
              <span className="thread-row-info-card__pr-number">#{number}</span>
              <span className="thread-row-info-card__pr-title">{summary.title}</span>
              {namesRepository ? (
                <span className="thread-row-info-card__pr-repository">
                  {summary.identity.repositoryName}
                </span>
              ) : null}
            </>
          );
          const tooltip = [
            `#${number} ${summary.title}`,
            meta,
            ...(openInReview === undefined
              ? []
              : [
                  externalUrl === undefined
                    ? "Opens in Review."
                    : "Opens in Review. Cmd-click opens on GitHub.",
                ]),
          ].join("\n");
          return (
            <span className="thread-row-info-card__pr" key={pullRequestKey(summary.identity)}>
              {openInReview === undefined ? (
                <span
                  aria-label={`Pull request #${number}: ${summary.title} · ${meta}`}
                  className="thread-row-info-card__pr-reference"
                  role="img"
                  title={tooltip}
                >
                  {reference}
                </span>
              ) : (
                <OctantButton
                  aria-label={`Open pull request #${number}: ${summary.title} · ${meta}`}
                  className="thread-row-info-card__pr-reference thread-row-info-card__pr-open"
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey) {
                      if (externalUrl !== undefined) openOnGithub?.(summary.identity);
                      return;
                    }
                    openInReview(summary.identity);
                  }}
                  title={tooltip}
                  type="button"
                  variant="ghost"
                >
                  {reference}
                </OctantButton>
              )}
              {externalUrl === undefined ? null : (
                <OctantIconButton
                  className="thread-row-info-card__pr-github"
                  label={`Open #${number} on GitHub`}
                  onClick={() => openOnGithub?.(summary.identity)}
                  title={`Open #${number} on GitHub`}
                  type="button"
                  variant="bare"
                >
                  <ExternalLink aria-hidden="true" size={14} />
                </OctantIconButton>
              )}
            </span>
          );
        })}
      </span>
      {props.summaries.hiddenCount === 0 ? null : (
        <span className="thread-row-info-card__pr-more">
          +{String(props.summaries.hiddenCount)} more
        </span>
      )}
    </span>
  );
}

/**
 * A delayed, non-modal summary of the facts the navigation row and its Project
 * context already carry, plus the row's exact linked pull requests.
 *
 * It reads on the ordinary raised surface rather than the inverted tooltip
 * ground: the card's own tokens paint `--oct-fg` text, which on the tooltip's
 * `--oct-fg` background rendered the title invisible and left the facts at a
 * grey that failed against near-black.
 */
export function ThreadRowInfoCard(props: {
  readonly actions: ThreadRowActions;
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}) {
  const states = threadRowStates(props.thread);
  const age = threadRowAge(props.thread.updatedAt);
  const facts = threadRowFacts({
    ...(props.lineageParentTitle === undefined
      ? {}
      : { lineageParentTitle: props.lineageParentTitle }),
    projectName: props.projectName,
    thread: props.thread,
  });
  return (
    <span className="thread-row-info-card">
      <span className="thread-row-info-card__header">
        <span className="thread-row-info-card__title">{props.thread.title}</span>
        {age === undefined ? null : <span className="thread-row-info-card__age">{age}</span>}
      </span>
      {states.length === 0 ? null : (
        <span className="thread-row-info-card__states">
          {states.map((state) => (
            <span className="thread-row-info-card__state" key={state}>
              {state}
            </span>
          ))}
        </span>
      )}
      {facts.length === 0 ? null : (
        <span className="thread-row-info-card__facts">
          {facts.map((fact) => (
            <span className="thread-row-info-card__fact" key={fact.key}>
              <fact.icon aria-hidden="true" size={14} />
              <span className="thread-row-info-card__fact-label">{fact.label}</span>
            </span>
          ))}
        </span>
      )}
      {props.thread.pullRequests === undefined ||
      (props.thread.pullRequests.items.length === 0 &&
        props.thread.pullRequests.hiddenCount === 0) ? null : (
        <ThreadRowPullRequests actions={props.actions} summaries={props.thread.pullRequests} />
      )}
    </span>
  );
}
