import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  CodeThreadId,
  GithubAssignedWorkItem,
  LinearIssueRow,
  ProjectId,
} from "@octant/contracts";
import { useEffect, useMemo, useState } from "react";
import type { ContinueCards } from "../code/useContinueCards";
import type { HomeListRead } from "./homeCards";
import { threadListId, type HomeListRow } from "./homeListModel";
import {
  assignedGithubListRow,
  assignedLinearListRow,
  continueBadge,
  continueListRow,
  openIssueListRow,
  openLinearListRow,
} from "./homeListRows";
import {
  DEFAULT_ISSUE_SORT,
  readIssuesAcrossRepositories,
  sortIssueRows,
  type RepositoryIssueRow,
} from "../github/readIssuesAcrossRepositories";

/**
 * The rows only a start screen with a GitHub or Linear connection, or a board
 * of threads, can add to the list: what is assigned to the person and the
 * threads worth picking back up. They are not cards in the registry, so
 * Customize does not list them, and they read when the screen mounts.
 */

type AssignedRead =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly github: ReadonlyArray<GithubAssignedWorkItem>;
      readonly linear: ReadonlyArray<LinearIssueRow>;
    };

export interface AssignedWorkSource {
  readonly githubClient?: GithubClient | undefined;
  readonly loadAssignedLinearIssues?:
    | (() => Promise<{ readonly rows: ReadonlyArray<LinearIssueRow> }>)
    | undefined;
  readonly onPickGithub: (item: GithubAssignedWorkItem) => void;
  readonly onPickLinear?: ((row: LinearIssueRow) => void) | undefined;
  readonly onOpenInbox?: (() => void) | undefined;
}

/**
 * Issues and pull requests assigned to the person, and their Linear issues. A
 * review request and an assigned issue wait on the person, so they sit under
 * Needs you; the person's own pull requests sit under Your pull requests. A
 * source that is not connected adds nothing, and one that fails says so only
 * when nothing else is on the list.
 */
export function useAssignedWorkRows(source: AssignedWorkSource): HomeListRead {
  const { githubClient, loadAssignedLinearIssues } = source;
  const [read, setRead] = useState<AssignedRead>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    // A later read keeps the answer already drawn until the fresh one lands.
    setRead((previous) => (previous.kind === "ready" ? previous : { kind: "loading" }));
    void (async () => {
      const [github, linear] = await Promise.all([
        readAssignedGithub(githubClient),
        readAssignedLinear(loadAssignedLinearIssues),
      ]);
      if (cancelled) return;
      if (github.kind === "failed" && linear.length === 0) {
        setRead({ kind: "failed", message: github.message });
        return;
      }
      setRead({
        kind: "ready",
        github: github.kind === "ready" ? github.items : [],
        linear,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [githubClient, loadAssignedLinearIssues]);
  const { onPickGithub, onPickLinear, onOpenInbox } = source;
  return useMemo((): HomeListRead => {
    if (read.kind === "loading") return { status: "loading" };
    if (read.kind === "failed") {
      return { status: "ready", rows: [], caveat: { text: read.message } };
    }
    const now = Date.now();
    return {
      status: "ready",
      ...(onOpenInbox === undefined
        ? {}
        : { seeAll: { "needs-you": { label: "See all", onSelect: onOpenInbox } } }),
      rows: [
        ...read.github.map((item) => assignedGithubListRow(item, now, () => onPickGithub(item))),
        ...read.linear.map((row) =>
          assignedLinearListRow(
            row,
            onPickLinear === undefined ? undefined : () => onPickLinear(row),
          ),
        ),
      ],
    };
  }, [read, onPickGithub, onPickLinear, onOpenInbox]);
}

export interface ContinueSource {
  readonly continueCards?: ContinueCards | undefined;
  readonly projectNames?: ReadonlyMap<string, string> | undefined;
  readonly onOpenThread?:
    | ((target: { readonly threadId: CodeThreadId; readonly projectId: ProjectId }) => void)
    | undefined;
}

/** The threads the board says to pick back up, with where each one stands. */
export function useContinueRows(source: ContinueSource): HomeListRead {
  const { continueCards, projectNames, onOpenThread } = source;
  return useMemo((): HomeListRead => {
    if (continueCards?.kind === "loading") return { status: "loading" };
    if (continueCards === undefined || continueCards.kind !== "ready") {
      return { status: "ready", rows: [] };
    }
    const now = Date.now();
    return {
      status: "ready",
      rows: continueCards.cards.map((card) =>
        continueListRow({
          card,
          badge: continueBadge(card),
          projectName: projectNames?.get(String(card.projectId)),
          now,
          onOpen:
            onOpenThread === undefined
              ? undefined
              : () => onOpenThread({ threadId: card.threadId, projectId: card.projectId }),
        }),
      ),
    };
  }, [continueCards, projectNames, onOpenThread]);
}

export interface RecentThreadSource {
  readonly id: string;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly onOpen: () => void;
}

/** Chat's and Work's latest threads, as the Continue section of the list. */
export function recentThreadRows(
  threads: ReadonlyArray<RecentThreadSource>,
): ReadonlyArray<HomeListRow> {
  return threads.map((thread) => ({
    id: threadListId(thread.id),
    section: "continue" as const,
    glyph: "thread" as const,
    tone: "neutral" as const,
    label: "Thread",
    title: thread.title,
    meta: thread.detail === undefined ? [] : [thread.detail],
    onOpen: thread.onOpen,
  }));
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
    return {
      kind: "failed",
      message: "GitHub returned a response Octant could not read. Refresh to try again.",
    };
  } catch (error) {
    return {
      kind: "failed",
      message:
        error instanceof Error && error.message !== ""
          ? error.message
          : "GitHub could not be reached. Refresh to try again.",
    };
  }
}

async function readAssignedLinear(
  load: AssignedWorkSource["loadAssignedLinearIssues"],
): Promise<ReadonlyArray<LinearIssueRow>> {
  if (load === undefined) return [];
  try {
    return (await load()).rows;
  } catch {
    return [];
  }
}

const FRESH_ISSUE_LIMIT = 5;

export interface OpenIssuesSource {
  readonly githubClient?: GithubClient | undefined;
  readonly loadOpenLinearIssues?:
    | (() => Promise<{ readonly rows: ReadonlyArray<LinearIssueRow> }>)
    | undefined;
  readonly onPickIssue: (row: RepositoryIssueRow) => void;
  readonly onPickLinear?: ((row: LinearIssueRow) => void) | undefined;
  readonly onOpenIssues?: (() => void) | undefined;
}

/**
 * Open issues nobody has been assigned, from the recent repositories and Linear.
 * The newest are chosen before the limit, because the reads land in whatever
 * order the repositories answer and taking the first few would drop a slow
 * repository's fresher issues. An issue already assigned to the person is
 * dropped by the list, which gives it to Needs you first.
 */
export function useOpenIssueRows(source: OpenIssuesSource): HomeListRead {
  const { githubClient, loadOpenLinearIssues } = source;
  const [read, setRead] = useState<
    | { readonly kind: "loading" }
    | {
        readonly kind: "ready";
        readonly rows: ReadonlyArray<RepositoryIssueRow>;
        readonly linear: ReadonlyArray<LinearIssueRow>;
      }
  >({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [rows, linear] = await Promise.all([
        readOpenGithubIssues(githubClient),
        readOpenLinear(loadOpenLinearIssues),
      ]);
      if (!cancelled) setRead({ kind: "ready", rows, linear });
    })();
    return () => {
      cancelled = true;
    };
  }, [githubClient, loadOpenLinearIssues]);
  const { onPickIssue, onPickLinear, onOpenIssues } = source;
  return useMemo((): HomeListRead => {
    if (read.kind === "loading") return { status: "loading" };
    const now = Date.now();
    return {
      status: "ready",
      ...(onOpenIssues === undefined
        ? {}
        : { seeAll: { "open-issues": { label: "See all", onSelect: onOpenIssues } } }),
      rows: [
        ...sortIssueRows(read.rows, DEFAULT_ISSUE_SORT).map((row) =>
          openIssueListRow(row, now, () => onPickIssue(row)),
        ),
        ...read.linear.map((row) =>
          openLinearListRow(row, onPickLinear === undefined ? undefined : () => onPickLinear(row)),
        ),
      ].slice(0, FRESH_ISSUE_LIMIT + 4),
    };
  }, [read, onPickIssue, onPickLinear, onOpenIssues]);
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
  load: OpenIssuesSource["loadOpenLinearIssues"],
): Promise<ReadonlyArray<LinearIssueRow>> {
  if (load === undefined) return [];
  try {
    return (await load()).rows;
  } catch {
    return [];
  }
}
