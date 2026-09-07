import { useEffect, useState, type ReactNode } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  CodeBoardCard,
  CodeBoardQuery,
  CodeBoardView,
  CodeThreadId,
  GithubAssignedWorkItem,
  LinearIssueRow,
  ProjectId,
} from "@octant/contracts";
import {
  CircleCheck,
  CircleDot,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  ListTodo,
  type LucideIcon,
} from "lucide-react";
import {
  DEFAULT_ISSUE_SORT,
  readIssuesAcrossRepositories,
  sortIssueRows,
  type RepositoryIssueRow,
} from "../github/readIssuesAcrossRepositories";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";

const UP_NEXT_LIMIT = 6;
const FRESH_ISSUE_LIMIT = 4;
const CONTINUE_LIMIT = 6;

/**
 * Up next names why each item is there, so a card here never reads as the
 * same thing as an open issue nobody has taken: assigned, yours, or asked
 * of you.
 */
const CATEGORY_LABELS: Readonly<Record<GithubAssignedWorkItem["category"], string>> = {
  issue: "Assigned to you",
  "pull-request": "Your pull request",
  "review-request": "Review requested",
};

const PULL_REQUEST_STATE_LABELS: Readonly<Record<"open" | "merged" | "closed", string>> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

export interface CodeHomeThreadTarget {
  readonly threadId: CodeThreadId;
  readonly projectId: ProjectId;
}

export interface CodeHomeProps {
  readonly githubClient?: GithubClient;
  readonly loadAssignedLinearIssues?: () => Promise<{
    readonly rows: ReadonlyArray<LinearIssueRow>;
  }>;
  /** Open Linear issues nobody is assigned; they join Start something new. */
  readonly loadOpenLinearIssues?: () => Promise<{
    readonly rows: ReadonlyArray<LinearIssueRow>;
  }>;
  readonly loadBoard?: (query: CodeBoardQuery) => Promise<CodeBoardView>;
  readonly projectNames?: ReadonlyMap<string, string>;
  readonly providerLabels?: ReadonlyMap<string, string>;
  readonly onPickGithub: (item: GithubAssignedWorkItem) => void;
  /** An open issue nobody has been assigned; the caller fills the prompt from it. */
  readonly onPickIssue: (row: RepositoryIssueRow) => void;
  readonly onPickLinear?: (row: LinearIssueRow) => void;
  readonly onOpenThread?: (target: CodeHomeThreadTarget) => void;
  readonly onOpenInbox?: () => void;
  readonly onOpenIssues?: () => void;
}

type UpNextState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly github: ReadonlyArray<GithubAssignedWorkItem>;
      readonly linear: ReadonlyArray<LinearIssueRow>;
      readonly githubAvailable: boolean;
    };

type FreshState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "ready";
      readonly rows: ReadonlyArray<RepositoryIssueRow>;
      readonly linear: ReadonlyArray<LinearIssueRow>;
    };

type ContinueState =
  | { readonly kind: "idle" }
  | { readonly kind: "ready"; readonly cards: ReadonlyArray<CodeBoardCard> };

/**
 * What the Code start screen offers under the composer: what is waiting on
 * the person (assigned GitHub work and Linear issues), open issues nobody has
 * picked up, and the threads worth continuing with their delivery state. Each
 * section hides rather than apologises when its source is not connected.
 */
export function CodeHome(props: CodeHomeProps) {
  const { githubClient, loadAssignedLinearIssues, loadOpenLinearIssues, loadBoard } = props;
  const [upNext, setUpNext] = useState<UpNextState>({ kind: "loading" });
  const [fresh, setFresh] = useState<FreshState>({ kind: "idle" });
  const [next, setNext] = useState<ContinueState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    setUpNext({ kind: "loading" });
    const read = async () => {
      const [github, linear] = await Promise.all([
        readAssignedGithub(githubClient),
        readAssignedLinear(loadAssignedLinearIssues),
      ]);
      if (cancelled) return;
      if (github.kind === "failed" && linear.length === 0) {
        setUpNext({ kind: "failed", message: github.message });
        return;
      }
      setUpNext({
        kind: "ready",
        github: github.kind === "ready" ? github.items : [],
        linear,
        githubAvailable: github.kind === "ready",
      });
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [githubClient, loadAssignedLinearIssues]);

  useEffect(() => {
    if (githubClient === undefined && loadOpenLinearIssues === undefined) {
      setFresh({ kind: "idle" });
      return;
    }
    let cancelled = false;
    const read = async () => {
      const [rows, linear] = await Promise.all([
        readOpenGithubIssues(githubClient),
        readOpenLinear(loadOpenLinearIssues),
      ]);
      if (cancelled) return;
      setFresh({ kind: "ready", rows, linear });
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [githubClient, loadOpenLinearIssues]);

  useEffect(() => {
    if (loadBoard === undefined) {
      setNext({ kind: "idle" });
      return;
    }
    let cancelled = false;
    loadBoard({ version: 1 }).then(
      (view) => {
        if (cancelled) return;
        const cards = [...view.cards]
          .sort((a, b) =>
            (b.lastMeaningfulActivityAt ?? "").localeCompare(a.lastMeaningfulActivityAt ?? ""),
          )
          .slice(0, CONTINUE_LIMIT);
        setNext({ kind: "ready", cards });
      },
      () => {
        if (!cancelled) setNext({ kind: "idle" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadBoard]);

  const assigned = new Set(
    upNext.kind === "ready"
      ? upNext.github.map((item) => `${item.owner}/${item.name}#${String(item.number)}`)
      : [],
  );
  const assignedLinear = new Set(
    upNext.kind === "ready" ? upNext.linear.map((row) => String(row.id)) : [],
  );
  // The reads land in whatever order the repositories answer, so the newest
  // issues have to be chosen before the limit rather than after it: taking the
  // first four as they arrive drops a slow repository's fresher issues.
  const freshRows =
    fresh.kind === "ready"
      ? [
          ...sortIssueRows(
            fresh.rows.filter(
              (row) => !assigned.has(`${row.owner}/${row.name}#${String(row.number)}`),
            ),
            DEFAULT_ISSUE_SORT,
          ).map((row) => ({ kind: "github" as const, row })),
          ...fresh.linear
            .filter((row) => !assignedLinear.has(String(row.id)))
            .map((row) => ({ kind: "linear" as const, row })),
        ].slice(0, FRESH_ISSUE_LIMIT)
      : [];
  const upNextRows =
    upNext.kind === "ready"
      ? [
          ...upNext.github.map((item) => ({ kind: "github" as const, item })),
          ...upNext.linear.map((row) => ({ kind: "linear" as const, row })),
        ].slice(0, UP_NEXT_LIMIT)
      : [];
  const showUpNext =
    upNext.kind === "loading" ||
    upNext.kind === "failed" ||
    (upNext.kind === "ready" && (upNext.githubAvailable || upNext.linear.length > 0));

  return (
    <div className="code-home">
      {showUpNext ? (
        <section aria-label="Up next" className="code-home__section">
          <SectionHead
            note="Issues and pull requests waiting on you across your connected repositories."
            title="Up next"
            {...(props.onOpenInbox === undefined
              ? {}
              : { actionLabel: "Open Inbox", onAction: props.onOpenInbox })}
          />
          {upNext.kind === "loading" ? (
            <div className="code-home__panel">
              <p className="code-home__note" role="status">
                Checking what is assigned to you…
              </p>
            </div>
          ) : upNext.kind === "failed" ? (
            <div className="code-home__panel">
              <p className="code-home__note" role="status">
                {upNext.message}
              </p>
            </div>
          ) : upNextRows.length === 0 ? (
            <div className="code-home__panel code-home__empty">
              <CircleCheck aria-hidden="true" size={20} strokeWidth={1.6} />
              <p className="code-home__empty-title">You're all caught up.</p>
              <p className="code-home__note">
                Nothing is assigned to you or waiting on your review.
              </p>
            </div>
          ) : (
            <ul className="code-home__grid">
              {upNextRows.map((entry) =>
                entry.kind === "github" ? (
                  <li key={`${entry.item.owner}/${entry.item.name}#${String(entry.item.number)}`}>
                    <HomeCard
                      badge={CATEGORY_LABELS[entry.item.category]}
                      icon={entry.item.category === "issue" ? CircleDot : GitPullRequest}
                      meta={entry.item.author}
                      onClick={() => props.onPickGithub(entry.item)}
                      source={`${entry.item.owner}/${entry.item.name} #${String(entry.item.number)}`}
                      title={entry.item.title}
                      updatedAt={entry.item.updatedAt}
                    />
                  </li>
                ) : (
                  <li key={entry.row.id}>
                    <HomeCard
                      badge="Linear"
                      disabled={props.onPickLinear === undefined}
                      icon={ListTodo}
                      meta={entry.row.state.name}
                      onClick={() => props.onPickLinear?.(entry.row)}
                      source={entry.row.identifier}
                      title={entry.row.title}
                    />
                  </li>
                ),
              )}
            </ul>
          )}
        </section>
      ) : null}

      {freshRows.length === 0 ? null : (
        <section aria-label="Start something new" className="code-home__section">
          <SectionHead
            note="Open issues nobody has picked up, from your recent repositories and Linear."
            title="Start something new"
            {...(props.onOpenIssues === undefined
              ? {}
              : { actionLabel: "Browse all issues", onAction: props.onOpenIssues })}
          />
          <ul className="code-home__grid">
            {freshRows.map((entry) =>
              entry.kind === "github" ? (
                <li key={`${entry.row.owner}/${entry.row.name}#${String(entry.row.number)}`}>
                  <HomeCard
                    badge="Open issue"
                    icon={CircleDot}
                    meta={entry.row.author}
                    onClick={() => props.onPickIssue(entry.row)}
                    source={`${entry.row.owner}/${entry.row.name} #${String(entry.row.number)}`}
                    title={entry.row.title}
                    updatedAt={entry.row.updatedAt}
                  />
                </li>
              ) : (
                <li key={entry.row.id}>
                  <HomeCard
                    badge="Linear"
                    disabled={props.onPickLinear === undefined}
                    icon={ListTodo}
                    meta={entry.row.state.name}
                    onClick={() => props.onPickLinear?.(entry.row)}
                    source={entry.row.identifier}
                    title={entry.row.title}
                  />
                </li>
              ),
            )}
          </ul>
        </section>
      )}

      {next.kind === "ready" && next.cards.length > 0 ? (
        <section aria-label="Continue" className="code-home__section">
          <SectionHead note="Your latest threads and where each one stands." title="Continue" />
          <ul className="code-home__grid code-home__grid--rows">
            {next.cards.map((card) => {
              const badge = cardBadge(card);
              return (
                <li key={String(card.threadId)}>
                  <HomeCard
                    badge={badge.label}
                    disabled={props.onOpenThread === undefined}
                    layout="row"
                    facts={
                      <ContinueFacts
                        card={card}
                        projectNames={props.projectNames}
                        providerLabels={props.providerLabels}
                      />
                    }
                    onClick={() =>
                      props.onOpenThread?.({ threadId: card.threadId, projectId: card.projectId })
                    }
                    title={card.title}
                    tone={badge.tone}
                    {...(badge.detail === undefined ? {} : { detail: badge.detail })}
                    {...(card.lastMeaningfulActivityAt === null
                      ? {}
                      : { updatedAt: card.lastMeaningfulActivityAt })}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function SectionHead(props: {
  readonly title: string;
  readonly note: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <header className="code-home__section-head">
      <div className="code-home__section-copy">
        <p className="code-home__section-title">{props.title}</p>
        <p className="code-home__section-note">{props.note}</p>
      </div>
      {props.onAction === undefined || props.actionLabel === undefined ? null : (
        <OctantButton onClick={props.onAction} size="sm" type="button" variant="ghost">
          {props.actionLabel}
        </OctantButton>
      )}
    </header>
  );
}

/**
 * One card shape for every section: what kind of thing it is, where it
 * lives, when it last moved, then the title and one line of facts. A
 * thread's tone colours the badge; issues and pull requests keep it quiet.
 */
function HomeCard(props: {
  readonly badge: string;
  readonly icon?: LucideIcon;
  readonly tone?: CardBadge["tone"];
  readonly detail?: string;
  readonly source?: string;
  readonly updatedAt?: string;
  readonly title: string;
  readonly meta?: string;
  /** A structured line of facts (icons and chips) instead of `meta`. */
  readonly facts?: ReactNode;
  /**
   * A card is something to start; a row is something that already exists.
   * Continue lists threads, so it takes rows over hairlines, not a second
   * wall of cards under the suggestions.
   */
  readonly layout?: "card" | "row";
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <OctantButton
      className={props.layout === "row" ? "code-home__row" : "code-home__card"}
      disabled={props.disabled === true}
      onClick={props.onClick}
      type="button"
      variant="ghost"
    >
      <span className="code-home__card-head">
        <span className="code-home__badge" data-tone={props.tone ?? "plain"}>
          {Icon === undefined ? null : <Icon aria-hidden="true" size={12} strokeWidth={1.9} />}
          {props.badge}
        </span>
        {props.detail === undefined ? null : (
          <span className="code-home__card-detail">{props.detail}</span>
        )}
        {props.source === undefined ? null : (
          <span className="code-home__card-source">{props.source}</span>
        )}
        {props.updatedAt === undefined ? null : (
          <span
            className="code-home__card-age"
            title={absoluteTimeFormatter.format(new Date(props.updatedAt))}
          >
            {relativeTimeLabel(props.updatedAt)}
          </span>
        )}
      </span>
      <span className="code-home__card-title">{props.title}</span>
      {props.facts !== undefined ? (
        props.facts
      ) : props.meta === undefined || props.meta === "" ? null : (
        <span className="code-home__card-meta">{props.meta}</span>
      )}
    </OctantButton>
  );
}

/**
 * Where a thread lives and what it has delivered: the Project, the branch
 * (and whether it is a managed worktree), the linked pull request with its
 * state, and the provider last. Each fact is named by an icon, not a label.
 */
function ContinueFacts(props: {
  readonly card: CodeBoardCard;
  readonly projectNames: ReadonlyMap<string, string> | undefined;
  readonly providerLabels: ReadonlyMap<string, string> | undefined;
}) {
  const { card } = props;
  const project = props.projectNames?.get(String(card.projectId));
  const provider = props.providerLabels?.get(String(card.providerInstanceId));
  const branch =
    card.worktree.kind === "available" && card.worktree.head.kind === "branch"
      ? card.worktree.head.name
      : undefined;
  const pullRequest = card.linkedPullRequest.kind === "linked" ? card.linkedPullRequest : undefined;
  return (
    <span className="code-home__facts">
      {project === undefined ? null : (
        <span className="code-home__fact">
          <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
          {project}
        </span>
      )}
      {branch === undefined ? null : (
        <span
          className="code-home__fact"
          title={card.checkoutKind === "managed-worktree" ? "Managed worktree" : undefined}
        >
          <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
          {branch}
          {card.checkoutKind === "managed-worktree" ? (
            <span className="code-home__fact-note">worktree</span>
          ) : null}
        </span>
      )}
      {pullRequest === undefined ? null : (
        <span className="code-home__fact code-home__fact--chip" data-tone={pullRequest.state}>
          <GitPullRequest aria-hidden="true" size={12} strokeWidth={1.8} />#{pullRequest.number}{" "}
          {PULL_REQUEST_STATE_LABELS[pullRequest.state]}
        </span>
      )}
      {provider === undefined ? null : (
        <span className="code-home__fact code-home__fact--muted">{provider}</span>
      )}
    </span>
  );
}

async function readAssignedGithub(
  client: GithubClient | undefined,
): Promise<
  | { readonly kind: "ready"; readonly items: ReadonlyArray<GithubAssignedWorkItem> }
  | { readonly kind: "hidden" }
  | { readonly kind: "failed"; readonly message: string }
> {
  if (client === undefined) return { kind: "hidden" };
  try {
    const response = await client.readCatalogue({ kind: "assigned-work" });
    if (response.kind === "assigned-work") {
      return {
        kind: "ready",
        items: [...response.page.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      };
    }
    if (response.kind === "unavailable") return { kind: "hidden" };
    return { kind: "failed", message: "GitHub returned an unexpected response." };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : "GitHub could not be reached.",
    };
  }
}

async function readOpenGithubIssues(
  client: GithubClient | undefined,
): Promise<ReadonlyArray<RepositoryIssueRow>> {
  if (client === undefined) return [];
  try {
    const recents = await client.readCatalogue({ kind: "recent-repositories" });
    if (recents.kind !== "recent-repositories" || recents.rows.length === 0) return [];
    // "Nobody has picked up" is what the section promises, so the read
    // asks GitHub for unassigned issues rather than dropping the ones
    // assigned to this person after the fact.
    const result = await readIssuesAcrossRepositories(client, recents.rows, {
      state: "open",
      pageSize: 10,
      assignee: "none",
    });
    return result.rows;
  } catch {
    // A refused catalogue leaves GitHub out of the section; the Issues
    // surface explains the refusal in its own words.
    return [];
  }
}

async function readOpenLinear(
  load: CodeHomeProps["loadOpenLinearIssues"],
): Promise<ReadonlyArray<LinearIssueRow>> {
  if (load === undefined) return [];
  try {
    return (await load()).rows;
  } catch {
    return [];
  }
}

async function readAssignedLinear(
  load: CodeHomeProps["loadAssignedLinearIssues"],
): Promise<ReadonlyArray<LinearIssueRow>> {
  if (load === undefined) return [];
  try {
    return (await load()).rows;
  } catch {
    return [];
  }
}

interface CardBadge {
  readonly label: string;
  readonly tone: "running" | "done" | "open" | "waiting" | "quiet";
  readonly detail?: string;
}

/**
 * The badge names the thread's own state: running beats the board status.
 * The pull request is a fact beside the branch, not the badge, so a merged
 * thread and a merged pull request read as two things. Changed lines ride
 * along when the checkout has any.
 */
export function cardBadge(card: CodeBoardCard): CardBadge {
  const detail =
    card.changedFiles.kind === "observed" &&
    (card.changedFiles.insertions > 0 || card.changedFiles.deletions > 0)
      ? `+${String(card.changedFiles.insertions)} −${String(card.changedFiles.deletions)}`
      : undefined;
  const withDetail = (badge: Omit<CardBadge, "detail">): CardBadge =>
    detail === undefined ? badge : { ...badge, detail };
  if (card.executing) return withDetail({ label: "Running", tone: "running" });
  switch (card.status) {
    case "done":
      return withDetail({ label: "Done", tone: "done" });
    case "waiting":
      return withDetail({ label: "Waiting", tone: "waiting" });
    case "in-progress":
      return withDetail({ label: "In progress", tone: "open" });
    case "ready":
      return withDetail({ label: "Ready", tone: "quiet" });
  }
}
