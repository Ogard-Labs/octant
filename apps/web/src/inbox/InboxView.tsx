import type { GithubCatalogueReadResponse } from "@octant/contracts";
import type { GithubAssignedWorkPage } from "@octant/contracts";
import type { AssignedLinearIssuesList } from "./loadAssignedLinearIssues";
import { CircleDot, GitPullRequest, ListTodo, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ThreadAttentionSignal } from "../notifications/threadAttention";
import { Surface, SurfaceEmpty, SurfaceHeader, SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import {
  ASSIGNED_WORK_CATEGORY_LABELS,
  ATTENTION_REASON_LABELS,
  assignedWorkSeenKey,
  linearIssueSeenKey,
  type InboxAttentionItem,
} from "./inboxModel";
import { markInboxKeySeen, readSeenInboxKeys } from "./inboxSeen";

export interface InboxViewProps {
  readonly attentionItems: ReadonlyArray<InboxAttentionItem>;
  readonly onOpenThread: (signal: ThreadAttentionSignal) => void;
  readonly onClose: () => void;
  /** Absent while the GitHub issues read is not connected; hides the section. */
  readonly loadAssignedGithubWork?: () => Promise<GithubCatalogueReadResponse>;
  /** Absent while Linear issue browsing is not connected; hides the section. */
  readonly loadAssignedLinearIssues?: () => Promise<AssignedLinearIssuesList>;
  /** Opens the full Linear issue browser when the inbox list is incomplete. */
  readonly onOpenLinearIssues?: () => void;
}

type GithubSection =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly page: GithubAssignedWorkPage }
  | { readonly kind: "failed"; readonly message: string };

type LinearSection =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly page: AssignedLinearIssuesList }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Everything waiting on the user, in one glance: threads blocked on an
 * approval or question, finished turns, and open GitHub/Linear work assigned
 * to the connected accounts. Rows are pointers — a thread opens in its own
 * surface, external work opens where it lives — so the inbox never becomes a
 * fourth browser. A source that fails reports on its own section; the others
 * still render.
 */
export function InboxView(props: InboxViewProps) {
  const [github, setGithub] = useState<GithubSection>({ kind: "loading" });
  const [linear, setLinear] = useState<LinearSection>({ kind: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(() => readSeenInboxKeys());
  const loadGithub = props.loadAssignedGithubWork;
  const loadLinear = props.loadAssignedLinearIssues;

  useEffect(() => {
    if (loadGithub === undefined) return;
    let cancelled = false;
    setGithub({ kind: "loading" });
    loadGithub().then(
      (response) => {
        if (cancelled) return;
        if (response.kind === "assigned-work") {
          setGithub({ kind: "ready", page: response.page });
        } else if (response.kind === "unavailable") {
          setGithub({ kind: "failed", message: "GitHub is unavailable right now." });
        } else {
          setGithub({ kind: "failed", message: "GitHub returned an unexpected response." });
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        setGithub({
          kind: "failed",
          message: error instanceof Error ? error.message : "GitHub request failed.",
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
    setLinear({ kind: "loading" });
    loadLinear().then(
      (page) => {
        if (!cancelled) setLinear({ kind: "ready", page });
      },
      (error: unknown) => {
        if (cancelled) return;
        setLinear({
          kind: "failed",
          message: error instanceof Error ? error.message : "Linear request failed.",
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

  return (
    <Surface ariaLabel="Inbox">
      <SurfaceHeader
        onBack={props.onClose}
        subtitle="What is waiting on you, across every mode."
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
                  Refresh
                </OctantButton>
              ),
            }
          : {})}
      />
      <SurfaceSection label="Needs you">
        {props.attentionItems.length === 0 ? (
          <SurfaceEmpty title="No thread is waiting on you." />
        ) : (
          <ul className="surface-list">
            {props.attentionItems.map((item) => (
              <li className="surface-row" key={`${item.signal.threadId}:${item.signal.reason}`}>
                <OctantButton
                  className="inbox-view__row"
                  onClick={() => props.onOpenThread(item.signal)}
                  type="button"
                  variant="ghost"
                >
                  <span className="surface-row__copy">
                    <span className="oct-row-label">{item.signal.title}</span>
                    <span className="oct-meta">
                      {ATTENTION_REASON_LABELS[item.signal.reason]}
                      {item.projectName === undefined ? "" : ` · ${item.projectName}`}
                    </span>
                    {item.signal.detail === undefined ? null : (
                      <span className="oct-row-detail">{item.signal.detail}</span>
                    )}
                  </span>
                </OctantButton>
              </li>
            ))}
          </ul>
        )}
      </SurfaceSection>
      {loadGithub === undefined ? null : (
        <SurfaceSection label="GitHub">
          {github.kind === "loading" ? (
            <p className="surface-section__note" role="status">
              Loading assigned work…
            </p>
          ) : github.kind === "failed" ? (
            <p className="surface-section__note" role="alert">
              {github.message}
            </p>
          ) : github.page.items.length === 0 ? (
            <SurfaceEmpty title="Nothing is assigned to you." />
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
      {loadLinear === undefined ? null : (
        <SurfaceSection label="Linear">
          {linear.kind === "loading" ? (
            <p className="surface-section__note" role="status">
              Loading assigned issues…
            </p>
          ) : linear.kind === "failed" ? (
            <p className="surface-section__note" role="alert">
              {linear.message}
            </p>
          ) : linear.page.rows.length === 0 ? (
            <SurfaceEmpty title="No Linear issues are assigned to you." />
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
