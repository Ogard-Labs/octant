import type { GithubCatalogueReadResponse } from "@octant/contracts";
import type { PendingRequest, WaitingAsk } from "@octant/contracts/pending-requests";
import type { GithubAssignedWorkPage } from "@octant/contracts";
import type { AssignedLinearIssuesList } from "./loadAssignedLinearIssues";
import { CircleDot, Folder, GitPullRequest, ListTodo, RefreshCw } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { ThreadAttentionSignal } from "../notifications/threadAttention";
import { PendingRequestRow } from "../pendingRequests/PendingRequestRow";
import { WaitingAskRow } from "../pendingRequests/WaitingAskRow";
import {
  canAnswerWaitingAsk,
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
import { Surface, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCard } from "../ui/base/OctantCard";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { useMinuteTick } from "../polling/useMinuteTick";
import { InboxPlanUsageRows, useInboxPlanUsage } from "./InboxPlanUsage";
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
import { markInboxKeySeen, readSeenInboxKeys } from "./inboxSeen";
import { ProjectIcon } from "../projects/ProjectIcon";
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
  /** Opens the thread of an ask a host service holds, where its own card answers it. */
  readonly onOpenAsk?: ((ask: WaitingAsk) => void) | undefined;
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
  const { rows: requestRows, answer, defer, asks, answerAsk } = usePendingRequestRows(decisions);
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
    decisions === undefined ? [] : asks,
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

  const planUsage = useInboxPlanUsage();
  // A page left open past midnight must change its date, in a remote window
  // too, which has no decision source and so no app clock. The page keeps its
  // own minute tick, cleared on unmount.
  const today = useMinuteTick();
  const refreshing = github.kind === "refreshing" || linear.kind === "refreshing";

  return (
    <Surface ariaLabel="Inbox" className="inbox-page">
      <SurfaceHeader
        detail={inboxStateSentence(counts.all, counts.urgent, today.getTime())}
        display
        onBack={props.onClose}
        title="Inbox"
        {...(externalSectionsPresent
          ? {
              actions: (
                <OctantTooltip label={refreshing ? "Refreshing…" : "Refresh"}>
                  <OctantIconButton
                    label={refreshing ? "Refreshing…" : "Refresh"}
                    onClick={() => setRefreshNonce((nonce) => nonce + 1)}
                    title=""
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" size={16} />
                  </OctantIconButton>
                </OctantTooltip>
              ),
            }
          : {})}
      />
      <div className="inbox-page__cards">
        <InboxCard
          actions={
            <OctantToggleGroup<InboxFilter>
              aria-label="Filter the Inbox"
              className="inbox-card__filters"
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
          }
          label="Needs you"
        >
          {groups.length === 0 ? (
            <div className="inbox-card__empty" role="status">
              <p className="oct-row-detail">{activeFilter?.empty}</p>
              {filter === "all" && props.onOpenBoard !== undefined ? (
                <OctantButton onClick={props.onOpenBoard} size="sm" type="button" variant="ghost">
                  Open the Board
                </OctantButton>
              ) : null}
            </div>
          ) : (
            groups.map((group) => (
              <section
                aria-label={group.name}
                className="inbox-group"
                key={group.projectKey === "" ? "no-project" : group.projectKey}
              >
                <h3 className="inbox-group__head">
                  {group.projectKey === "" ? (
                    <Folder aria-hidden="true" className="icon" size={14} />
                  ) : (
                    <ProjectIcon
                      fallback={<Folder aria-hidden="true" className="icon" size={14} />}
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
                      <li className="surface-row inbox-row" key={item.key}>
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
                    ) : item.kind === "ask" ? (
                      <li className="surface-row inbox-row" key={item.key}>
                        <WaitingAskRow
                          ask={item.ask}
                          now={decisions?.now ?? 0}
                          onAnswer={
                            canAnswerWaitingAsk(decisions?.askClients, item.ask)
                              ? answerAsk
                              : undefined
                          }
                          onOpenThread={(ask) => decisions?.onOpenAsk?.(ask)}
                          projectName={
                            item.ask.projectId === undefined
                              ? undefined
                              : decisions?.projectNames.get(String(item.ask.projectId))
                          }
                        />
                      </li>
                    ) : (
                      <li className="surface-row inbox-row" key={item.key}>
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
        </InboxCard>
        <div className="inbox-page__side">
          {loadGithub === undefined ? null : (
            <InboxCard label="GitHub">
              {github.kind === "loading" ? (
                <p className="oct-row-detail inbox-card__note" role="status">
                  Loading assigned work…
                </p>
              ) : github.kind === "failed" ? (
                <OctantAlert className="inbox-card__note" tone="warning">
                  {github.message}
                </OctantAlert>
              ) : github.page.items.length === 0 ? (
                <p className="oct-row-detail inbox-card__note" role="status">
                  Nothing is assigned to you.
                </p>
              ) : (
                <>
                  {github.page.freshness.status === "stale" ? (
                    <p className="oct-row-detail inbox-card__note" role="status">
                      Showing the last loaded list; GitHub could not be reached.
                    </p>
                  ) : null}
                  <ul className="surface-list">
                    {github.page.items.map((item) => {
                      const key = assignedWorkSeenKey(item);
                      const Icon = item.category === "issue" ? CircleDot : GitPullRequest;
                      return (
                        <li
                          className="surface-row inbox-row"
                          key={`${item.owner}/${item.name}#${item.number}`}
                        >
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
                                <Icon aria-hidden="true" className="icon" size={14} />
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
            </InboxCard>
          )}
          {loadLinear === undefined ? null : (
            <InboxCard label="Linear">
              {linear.kind === "loading" ? (
                <p className="oct-row-detail inbox-card__note" role="status">
                  Loading assigned issues…
                </p>
              ) : linear.kind === "failed" ? (
                <OctantAlert className="inbox-card__note" tone="warning">
                  {linear.message}
                </OctantAlert>
              ) : linear.page.rows.length === 0 ? (
                <p className="oct-row-detail inbox-card__note" role="status">
                  No Linear issues are assigned to you.
                </p>
              ) : (
                <>
                  {linear.page.hasNextPage ? (
                    <p className="oct-row-detail inbox-card__note" role="status">
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
                        <li className="surface-row inbox-row" key={row.id}>
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
                                <ListTodo aria-hidden="true" className="icon" size={14} />
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
            </InboxCard>
          )}
          {planUsage.length === 0 ? null : (
            <InboxCard label="Plan usage">
              <InboxPlanUsageRows usage={planUsage} />
            </InboxCard>
          )}
        </div>
      </div>
    </Surface>
  );
}

/**
 * One raised card of the Inbox: its small label at the top in the meta ink,
 * with the card's own controls at the trailing edge of that row.
 */
function InboxCard(props: {
  readonly label: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  return (
    <OctantCard aria-labelledby={headingId} className="inbox-card">
      <div className="inbox-card__head">
        <h2 className="oct-section-label" id={headingId}>
          {props.label}
        </h2>
        {props.actions}
      </div>
      <div className="inbox-card__body">{props.children}</div>
    </OctantCard>
  );
}

/**
 * The page's state in one line beside the title: today's date in the person's
 * locale and what waits. No greeting by time of day.
 */
export function inboxStateSentence(waiting: number, urgent: number, now: number): string {
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
  const state =
    waiting === 0
      ? "Nothing is waiting on you."
      : waiting === 1
        ? "1 thread is waiting on you."
        : `${waiting} threads are waiting on you.`;
  return urgent === 0 ? `${date} · ${state}` : `${date} · ${state} ${urgent} urgent.`;
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
