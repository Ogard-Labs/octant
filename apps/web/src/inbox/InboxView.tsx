import type { GithubCatalogueReadResponse } from "@octant/contracts";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import type { GithubAssignedWorkPage } from "@octant/contracts";
import type { AssignedLinearIssuesList } from "./loadAssignedLinearIssues";
import { CircleDot, Folder, GitPullRequest, Inbox, ListTodo, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ThreadAttentionSignal } from "../notifications/threadAttention";
import { PendingRequestRow } from "../pendingRequests/PendingRequestRow";
import {
  isFindOnlyPendingRequest,
  isLeadApprovalPendingRequest,
  isLeadQuestionPendingRequest,
  pendingRequestKey,
} from "../pendingRequests/pendingRequests";
import {
  usePendingRequestRows,
  type PendingRequestRowEntry,
  type PendingRequestRowsSource,
} from "../pendingRequests/usePendingRequestRows";
import { Surface, SurfaceEmpty, SurfaceHeader, SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import {
  ASSIGNED_WORK_CATEGORY_LABELS,
  INBOX_FILTERS,
  assignedWorkSeenKey,
  groupInboxByProject,
  inboxAttentionMeta,
  inboxFilterCounts,
  inboxWaitingItems,
  linearIssueSeenKey,
  matchesInboxFilter,
  type InboxAttentionItem,
  type InboxFilter,
} from "./inboxModel";
import { ProjectIcon } from "../projects/ProjectIcon";
import { markInboxKeySeen, readSeenInboxKeys } from "./inboxSeen";
import { OctantAlert } from "../ui/base/OctantAlert";

/**
 * The window's pending-request reader, for the decisions finished turns asked
 * and the subagents waiting on the person. Absent in a remote window, which
 * has no such source.
 */
export interface InboxDecisionSource extends PendingRequestRowsSource {
  readonly projectNames: ReadonlyMap<string, string>;
  /** Each worker's coordinator title, by worker thread id, from the window's thread list. */
  readonly coordinatorTitles?: ReadonlyMap<string, string>;
  /**
   * Opens the thread, where Reply… lets the person type their own answer; for a
   * waiting subagent, opens the thread's Agents tool on that subagent.
   */
  readonly onOpenThread: (request: PendingRequest) => void;
}

export interface InboxViewProps {
  readonly attentionItems: ReadonlyArray<InboxAttentionItem>;
  readonly decisions?: InboxDecisionSource;
  readonly onOpenThread: (signal: ThreadAttentionSignal) => void;
  readonly onClose: () => void;
  /** Absent while the GitHub issues read is not connected; hides the section. */
  readonly loadAssignedGithubWork?: () => Promise<GithubCatalogueReadResponse>;
  /** Absent while Linear issue browsing is not connected; hides the section. */
  readonly loadAssignedLinearIssues?: () => Promise<AssignedLinearIssuesList>;
  /** Opens the full Linear issue browser when the inbox list is incomplete. */
  readonly onOpenLinearIssues?: () => void;
  /** The next step from an empty Inbox: see every thread on the Board. */
  readonly onOpenBoard?: () => void;
}

type GithubSection =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly page: GithubAssignedWorkPage }
  | { readonly kind: "refreshing"; readonly page: GithubAssignedWorkPage }
  | { readonly kind: "failed"; readonly message: string };

type LinearSection =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly page: AssignedLinearIssuesList }
  | { readonly kind: "refreshing"; readonly page: AssignedLinearIssuesList }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Everything waiting on the user, in one glance: threads blocked on an
 * approval or question, decisions finished turns asked (answered right here,
 * as the thread's next turn), finished turns, and open GitHub/Linear work
 * assigned to the connected accounts. Rows are pointers — a thread opens in its own
 * surface, external work opens where it lives — so the inbox never becomes a
 * fourth browser. A source that fails reports on its own section; the others
 * still render.
 */
export function InboxView(props: InboxViewProps) {
  const [github, setGithub] = useState<GithubSection>({ kind: "loading" });
  const [linear, setLinear] = useState<LinearSection>({ kind: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(() => readSeenInboxKeys());
  const loadGithub = props.loadAssignedGithubWork;
  const loadLinear = props.loadAssignedLinearIssues;

  useEffect(() => {
    if (loadGithub === undefined) return;
    let cancelled = false;
    // A refresh keeps the rows already on screen; only the first read shows a
    // loading line.
    setGithub((previous) =>
      previous.kind === "ready" ? { kind: "refreshing", page: previous.page } : previous,
    );
    loadGithub().then(
      (response) => {
        if (cancelled) return;
        if (response.kind === "assigned-work") {
          setGithub({ kind: "ready", page: response.page });
        } else if (response.kind === "unavailable") {
          setGithub({ kind: "failed", message: "GitHub is unavailable right now." });
        } else {
          setGithub({
            kind: "failed",
            message: "GitHub returned a response Octant could not read. Refresh to try again.",
          });
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        setGithub({
          kind: "failed",
          message:
            error instanceof Error && error.message !== ""
              ? error.message
              : "GitHub could not be reached. Refresh to try again.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadGithub, refreshNonce]);

  useEffect(() => {
    if (loadLinear === undefined) return;
    let cancelled = false;
    setLinear((previous) =>
      previous.kind === "ready" ? { kind: "refreshing", page: previous.page } : previous,
    );
    loadLinear().then(
      (page) => {
        if (!cancelled) setLinear({ kind: "ready", page });
      },
      (error: unknown) => {
        if (cancelled) return;
        setLinear({
          kind: "failed",
          message:
            error instanceof Error && error.message !== ""
              ? error.message
              : "Linear could not be reached. Refresh to try again.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadLinear, refreshNonce]);

  function markSeen(key: string) {
    markInboxKeySeen(key);
    setSeenKeys((current) => new Set([...current, key]));
  }

  const externalSectionsPresent = loadGithub !== undefined || loadLinear !== undefined;
  const decisions = props.decisions;
  const { rows: requestRows, answer, defer } = usePendingRequestRows(decisions);
  // Questions use their exact pending request so attention deferral does not
  // hide an execution approval or create a duplicate thread attention row.
  const decisionRows = (requestRows ?? []).filter(
    (entry) =>
      entry.request.kind === "question" ||
      entry.request.kind === "decision" ||
      isFindOnlyPendingRequest(entry.request),
  );
  // A thread whose agent waits on its own approval or question is listed once,
  // as that request, rather than again as the thread's attention signal for it.
  const approving = threadsWith(decisionRows, isLeadApprovalPendingRequest);
  const asking = threadsWith(
    decisionRows,
    (request) => request.kind === "question" || isLeadQuestionPendingRequest(request),
  );
  // A finished turn that closed with a decision is already listed as that
  // decision, so it is not listed again under Finished.
  const deciding = threadsWith(decisionRows, (request) => request.kind === "decision");
  const attentionItems = props.attentionItems.filter(
    (item) =>
      !(item.signal.reason === "approval-required" && approving.has(item.signal.threadId)) &&
      !(item.signal.reason === "question-asked" && asking.has(item.signal.threadId)) &&
      !(item.signal.reason === "turn-finished" && deciding.has(item.signal.threadId)),
  );

  const waiting = inboxWaitingItems(
    decisions === undefined ? [] : decisionRows,
    attentionItems,
    decisions?.now ?? 0,
  );
  const counts = inboxFilterCounts(waiting);
  const projectNames = new Map([
    ...attentionItems.flatMap((item) =>
      item.signal.projectId === undefined || item.projectName === undefined
        ? []
        : [[item.signal.projectId, item.projectName] as const],
    ),
    ...(decisions?.projectNames ?? []),
  ]);
  const groups = groupInboxByProject(
    waiting.filter((item) => matchesInboxFilter(item, filter)),
    projectNames,
  );
  const activeFilter = INBOX_FILTERS.find((entry) => entry.id === filter);
  const showAssigned = filter === "all";

  return (
    <Surface ariaLabel="Inbox" measure="wide">
      <SurfaceHeader
        onBack={props.onClose}
        title="Inbox"
        {...(externalSectionsPresent
          ? {
              actions: (
                <OctantButton
                  onClick={() => setRefreshNonce((nonce) => nonce + 1)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCw aria-hidden="true" className="icon" size={14} strokeWidth={1.5} />
                  {github.kind === "refreshing" || linear.kind === "refreshing"
                    ? "Refreshing…"
                    : "Refresh"}
                </OctantButton>
              ),
            }
          : {})}
      />
      <p className="oct-meta inbox-view__summary">
        {`${counts.all} waiting`}
        {counts.urgent === 0 ? null : (
          <>
            {" · "}
            <span className="inbox-view__urgent">{`${counts.urgent} urgent`}</span>
          </>
        )}
      </p>
      <OctantToggleGroup<InboxFilter>
        aria-label="Filter the Inbox"
        className="inbox-view__filters"
        onValueChange={(value) => {
          const next = INBOX_FILTERS.find((entry) => entry.id === value[0]);
          if (next !== undefined) setFilter(next.id);
        }}
        value={[filter]}
      >
        {INBOX_FILTERS.map((entry) => (
          <OctantToggleGroupItem key={entry.id} value={entry.id}>
            {entry.label}
            <span className="oct-meta">{counts[entry.id]}</span>
          </OctantToggleGroupItem>
        ))}
      </OctantToggleGroup>
      <SurfaceSection label="Needs you">
        {groups.length === 0 ? (
          filter === "all" ? (
            <SurfaceEmpty
              icon={<Inbox size={20} strokeWidth={1.5} />}
              title="No thread is waiting on you"
              {...(props.onOpenBoard === undefined
                ? {}
                : {
                    action: (
                      <OctantButton
                        onClick={props.onOpenBoard}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Open the Board
                      </OctantButton>
                    ),
                  })}
            />
          ) : (
            <p className="surface-section__note" role="status">
              {activeFilter?.empty}
            </p>
          )
        ) : (
          groups.map((group) => (
            <section
              aria-label={group.name}
              className="inbox-group"
              key={group.projectKey === "" ? "no-project" : group.projectKey}
            >
              <h3 className="inbox-group__head">
                {group.projectKey === "" ? (
                  <Folder aria-hidden="true" className="icon" size={14} strokeWidth={1.5} />
                ) : (
                  <ProjectIcon
                    fallback={
                      <Folder aria-hidden="true" className="icon" size={14} strokeWidth={1.5} />
                    }
                    projectId={group.projectKey}
                    size={14}
                  />
                )}
                <span className="oct-row-label">{group.name}</span>
                <span className="oct-meta">{group.items.length}</span>
                {group.urgentCount === 0 ? null : (
                  <span className="oct-meta inbox-view__urgent">{`${group.urgentCount} urgent`}</span>
                )}
              </h3>
              <ul className="surface-list">
                {group.items.map((item) =>
                  item.kind === "request" ? (
                    <li className="surface-row" key={item.key}>
                      <PendingRequestRow
                        coordinatorTitle={decisions?.coordinatorTitles?.get(
                          String(item.entry.request.threadId),
                        )}
                        onDefer={defer}
                        now={decisions?.now ?? 0}
                        onAnswer={answer}
                        onOpenThread={(request) => decisions?.onOpenThread(request)}
                        projectName={decisions?.projectNames.get(
                          String(item.entry.request.projectId),
                        )}
                        request={item.entry.request}
                        settled={item.entry.unlisted}
                      />
                    </li>
                  ) : (
                    <li className="surface-row" key={item.key}>
                      <OctantButton
                        className="inbox-view__row"
                        onClick={() => props.onOpenThread(item.item.signal)}
                        type="button"
                        variant="bare"
                      >
                        <span className="surface-row__copy">
                          <span className="oct-row-label">{item.item.signal.title}</span>
                          <span className="oct-meta">{inboxAttentionMeta(item.item)}</span>
                          {item.item.signal.detail === undefined ? null : (
                            <span className="oct-row-detail">{item.item.signal.detail}</span>
                          )}
                        </span>
                      </OctantButton>
                    </li>
                  ),
                )}
              </ul>
            </section>
          ))
        )}
      </SurfaceSection>
      {loadGithub === undefined || !showAssigned ? null : (
        <SurfaceSection label="GitHub">
          {github.kind === "loading" ? (
            <p className="surface-section__note" role="status">
              Loading assigned work…
            </p>
          ) : github.kind === "failed" ? (
            <OctantAlert className="surface-section__note" tone="warning">
              {github.message}
            </OctantAlert>
          ) : github.page.items.length === 0 ? (
            <SurfaceEmpty title="Nothing is assigned to you" />
          ) : (
            <>
              {github.page.freshness.status === "stale" ? (
                <p className="surface-section__note" role="status">
                  Showing the last loaded list; GitHub could not be reached.
                </p>
              ) : null}
              <ul className="surface-list">
                {github.page.items.map((item) => {
                  const key = assignedWorkSeenKey(item);
                  const Icon = item.category === "issue" ? CircleDot : GitPullRequest;
                  return (
                    <li className="surface-row" key={`${item.owner}/${item.name}#${item.number}`}>
                      <a
                        className="inbox-view__row"
                        data-unseen={seenKeys.has(key) ? undefined : "true"}
                        href={item.url}
                        onClick={() => markSeen(key)}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {seenKeys.has(key) ? null : <span className="sr-only">Unseen</span>}
                        <span className="surface-row__copy">
                          <span className="oct-row-label">
                            <Icon aria-hidden="true" className="icon" size={14} strokeWidth={1.5} />
                            {item.title}
                          </span>
                          <span className="oct-meta">
                            {ASSIGNED_WORK_CATEGORY_LABELS[item.category]} · {item.owner}/
                            {item.name}#{item.number}
                          </span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </SurfaceSection>
      )}
      {loadLinear === undefined || !showAssigned ? null : (
        <SurfaceSection label="Linear">
          {linear.kind === "loading" ? (
            <p className="surface-section__note" role="status">
              Loading assigned issues…
            </p>
          ) : linear.kind === "failed" ? (
            <OctantAlert className="surface-section__note" tone="warning">
              {linear.message}
            </OctantAlert>
          ) : linear.page.rows.length === 0 ? (
            <SurfaceEmpty title="No Linear issues are assigned to you" />
          ) : (
            <>
              {linear.page.hasNextPage ? (
                <p className="surface-section__note" role="status">
                  Showing the first {linear.page.rows.length} assigned issues.
                  {props.onOpenLinearIssues === undefined ? (
                    " Open Linear for the rest."
                  ) : (
                    <>
                      {" "}
                      <OctantButton
                        onClick={props.onOpenLinearIssues}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Open Linear
                      </OctantButton>{" "}
                      for the rest.
                    </>
                  )}
                </p>
              ) : null}
              <ul className="surface-list">
                {linear.page.rows.map((row) => {
                  const key = linearIssueSeenKey(row);
                  return (
                    <li className="surface-row" key={row.id}>
                      <a
                        className="inbox-view__row"
                        data-unseen={seenKeys.has(key) ? undefined : "true"}
                        href={row.url}
                        onClick={() => markSeen(key)}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {seenKeys.has(key) ? null : <span className="sr-only">Unseen</span>}
                        <span className="surface-row__copy">
                          <span className="oct-row-label">
                            <ListTodo
                              aria-hidden="true"
                              className="icon"
                              size={14}
                              strokeWidth={1.5}
                            />
                            {row.title}
                          </span>
                          <span className="oct-meta">
                            {row.identifier} · {row.state.name}
                          </span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </SurfaceSection>
      )}
    </Surface>
  );
}

/** The threads whose listed request is of one find-only kind. */
function threadsWith(
  rows: ReadonlyArray<PendingRequestRowEntry>,
  matches: (request: PendingRequest) => boolean,
): ReadonlySet<string> {
  return new Set(
    rows.filter((entry) => matches(entry.request)).map((entry) => String(entry.request.threadId)),
  );
}
