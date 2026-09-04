import { useEffect, useState } from "react";
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
import { CircleCheck, CircleDot, GitPullRequest, ListTodo, type LucideIcon } from "lucide-react";
import {
  readIssuesAcrossRepositories,
  type RepositoryIssueRow,
} from "../github/readIssuesAcrossRepositories";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";

const UP_NEXT_LIMIT = 6;
const FRESH_ISSUE_LIMIT = 4;
const CONTINUE_LIMIT = 6;

const CATEGORY_LABELS: Readonly<Record<GithubAssignedWorkItem["category"], string>> = {
  issue: "Issue",
  "pull-request": "Pull request",
  "review-request": "Review requested",
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
  | { readonly kind: "ready"; readonly rows: ReadonlyArray<RepositoryIssueRow> };

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
  const { githubClient, loadAssignedLinearIssues, loadBoard } = props;
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
    if (githubClient === undefined) {
      setFresh({ kind: "idle" });
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const recents = await githubClient.readCatalogue({ kind: "recent-repositories" });
        if (cancelled || recents.kind !== "recent-repositories" || recents.rows.length === 0) {
          return;
        }
        const result = await readIssuesAcrossRepositories(githubClient, recents.rows, {
          state: "open",
          pageSize: 10,
        });
        if (cancelled) return;
        setFresh({ kind: "ready", rows: result.rows });
      } catch {
        // A refused catalogue leaves the section out; the Issues surface
        // explains the refusal in its own words.
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [githubClient]);

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
  const freshRows =
    fresh.kind === "ready"
      ? fresh.rows
          .filter((row) => !assigned.has(`${row.owner}/${row.name}#${String(row.number)}`))
          .slice(0, FRESH_ISSUE_LIMIT)
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
            note="Open issues in your recent repositories that nobody has picked up."
            title="Start something new"
            {...(props.onOpenIssues === undefined
              ? {}
              : { actionLabel: "Browse all issues", onAction: props.onOpenIssues })}
          />
          <ul className="code-home__grid">
            {freshRows.map((row) => (
              <li key={`${row.owner}/${row.name}#${String(row.number)}`}>
                <HomeCard
                  badge="Issue"
                  icon={CircleDot}
                  meta={row.author}
                  onClick={() => props.onPickIssue(row)}
                  source={`${row.owner}/${row.name} #${String(row.number)}`}
                  title={row.title}
                  updatedAt={row.updatedAt}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {next.kind === "ready" && next.cards.length > 0 ? (
        <section aria-label="Continue" className="code-home__section">
          <SectionHead note="Your latest threads and where each one stands." title="Continue" />
          <ul className="code-home__grid">
            {next.cards.map((card) => {
              const badge = cardBadge(card);
              const facts = cardFacts(card, props.projectNames, props.providerLabels);
              return (
                <li key={String(card.threadId)}>
                  <HomeCard
                    badge={badge.label}
                    disabled={props.onOpenThread === undefined}
                    meta={facts.join(" · ")}
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
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <OctantButton
      className="code-home__card"
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
      {props.meta === undefined || props.meta === "" ? null : (
        <span className="code-home__card-meta">{props.meta}</span>
      )}
    </OctantButton>
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
  readonly tone: "running" | "merged" | "open" | "done" | "waiting" | "quiet";
  readonly detail?: string;
}

/**
 * The tile names the one fact that says where the thread stands: running
 * beats a pull request state, which beats the board status. Changed lines
 * ride along when the checkout has any.
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
  if (card.linkedPullRequest.kind === "linked") {
    const pullRequest = card.linkedPullRequest;
    if (pullRequest.state === "merged") return withDetail({ label: "Merged", tone: "merged" });
    if (pullRequest.state === "closed") return withDetail({ label: "Closed", tone: "quiet" });
    return withDetail({ label: `PR #${String(pullRequest.number)}`, tone: "open" });
  }
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

function cardFacts(
  card: CodeBoardCard,
  projectNames: ReadonlyMap<string, string> | undefined,
  providerLabels: ReadonlyMap<string, string> | undefined,
): ReadonlyArray<string> {
  const facts: string[] = [];
  const provider = providerLabels?.get(String(card.providerInstanceId));
  if (provider !== undefined) facts.push(provider);
  const project = projectNames?.get(String(card.projectId));
  if (project !== undefined) facts.push(project);
  if (card.worktree.kind === "available" && card.worktree.head.kind === "branch") {
    facts.push(card.worktree.head.name);
  }
  return facts;
}
