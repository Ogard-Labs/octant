import { useCallback, useEffect, useRef, useState } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  GithubCatalogueFreshness,
  GithubCatalogueUnavailable,
  GithubIssueDetail,
  GithubIssueRow,
  GithubIssueStateFilter,
  GithubRepositoryRow,
} from "@octant/contracts";
import { ChevronDown, FolderGit2, Search } from "lucide-react";
import { GitHubRepositoryPicker } from "../code/GitHubRepositoryPicker";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { Surface, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

/**
 * Host-scoped, read-only GitHub issue browser. Repository selection reuses
 * the catalogue picker; issue list and detail reads stay on the existing
 * catalogue client. The pane never renders markdown or followable links.
 */

export interface GitHubIssueBrowserProps {
  readonly client: GithubClient;
  readonly onClose?: () => void;
}

type IssueListState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "unavailable";
      readonly reason: GithubCatalogueUnavailable["reason"];
      readonly remediation?: string;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly kind: "ready";
      readonly rows: ReadonlyArray<GithubIssueRow>;
      readonly hasNextPage: boolean;
      readonly endCursor?: string;
      readonly freshness: GithubCatalogueFreshness;
    };

type IssueDetailState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "unavailable";
      readonly reason: GithubCatalogueUnavailable["reason"];
      readonly remediation?: string;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly kind: "ready";
      readonly issue: GithubIssueDetail;
      readonly freshness: GithubCatalogueFreshness;
    };

type PaginationFailure =
  | Extract<IssueListState, { readonly kind: "unavailable" }>
  | { readonly kind: "error"; readonly message: string };

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;

const STALE_REASON_LABELS: Readonly<Record<string, string>> = {
  "rate-limited": "GitHub reported a rate limit.",
  "refresh-failed": "The last refresh failed.",
  "authentication-changed": "The GitHub authentication changed.",
  disconnected: "The host was disconnected from GitHub.",
};

const UNAVAILABLE_FALLBACKS: Readonly<Record<GithubCatalogueUnavailable["reason"], string>> = {
  unauthorized: "GitHub is not connected on this host.",
  "scope-limited": "The GitHub account is missing a required scope.",
  "rate-limited": "GitHub reported a rate limit. Try again later.",
  "insecure-storage": "The host's GitHub credential storage is insecure.",
  "external-token": "An ambient GitHub token blocks this capability.",
  "invalid-cursor": "The issue page reference expired. Refresh the list.",
  unavailable: "GitHub issues are unavailable on this host.",
};

const STATE_FILTERS: ReadonlyArray<{
  readonly value: GithubIssueStateFilter;
  readonly label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export function GitHubIssueBrowser(props: GitHubIssueBrowserProps) {
  const { client } = props;
  const [repository, setRepository] = useState<GithubRepositoryRow>();
  const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false);
  const [stateFilter, setStateFilter] = useState<GithubIssueStateFilter>("open");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const [list, setList] = useState<IssueListState>({ kind: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationFailure, setPaginationFailure] = useState<PaginationFailure>();
  const [selectedNumber, setSelectedNumber] = useState<number>();
  const [detail, setDetail] = useState<IssueDetailState>({ kind: "idle" });
  const [detailEpoch, setDetailEpoch] = useState(0);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);

  const loadList = useCallback(
    async (options: { readonly cursor?: string; readonly append?: boolean } = {}) => {
      if (repository === undefined) return;
      const operation = options.append === true ? listGeneration.current : ++listGeneration.current;
      if (options.append !== true) {
        ++detailGeneration.current;
        setPaginationFailure(undefined);
        setList({ kind: "loading" });
        setSelectedNumber(undefined);
        setDetail({ kind: "idle" });
      }
      try {
        const response = await client.readCatalogue({
          kind: "issues",
          owner: repository.owner,
          name: repository.name,
          pageSize: PAGE_SIZE,
          state: stateFilter,
          ...(debouncedSearch === "" ? {} : { search: debouncedSearch }),
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        });
        if (operation !== listGeneration.current) return;
        if (response.kind === "unavailable") {
          if (options.append === true) {
            setPaginationFailure(unavailableState(response));
            return;
          }
          setList(unavailableState(response));
          return;
        }
        if (response.kind !== "issues") {
          if (options.append === true) {
            setPaginationFailure({
              kind: "error",
              message: "GitHub returned an unexpected response.",
            });
            return;
          }
          setList({ kind: "error", message: "GitHub returned an unexpected response." });
          return;
        }
        setPaginationFailure(undefined);
        setList((current) => {
          const rows =
            options.append === true && current.kind === "ready"
              ? [...current.rows, ...response.page.rows]
              : response.page.rows;
          return {
            kind: "ready",
            rows,
            hasNextPage: response.page.hasNextPage,
            ...(response.page.endCursor === undefined
              ? {}
              : { endCursor: response.page.endCursor }),
            freshness: response.page.freshness,
          };
        });
      } catch (error) {
        if (operation !== listGeneration.current) return;
        if (options.append === true) {
          setPaginationFailure({
            kind: "error",
            message: error instanceof Error ? error.message : "GitHub issues are unavailable.",
          });
          return;
        }
        setList({
          kind: "error",
          message: error instanceof Error ? error.message : "GitHub issues are unavailable.",
        });
      }
    },
    [client, debouncedSearch, repository, stateFilter],
  );

  useEffect(() => {
    if (repository === undefined) {
      setList({ kind: "idle" });
      setSelectedNumber(undefined);
      setDetail({ kind: "idle" });
      return;
    }
    void loadList();
  }, [loadList, repository]);

  useEffect(() => {
    if (repository === undefined || selectedNumber === undefined) {
      if (selectedNumber === undefined) setDetail({ kind: "idle" });
      return;
    }
    const operation = ++detailGeneration.current;
    setDetail({ kind: "loading" });
    void client
      .readCatalogue({
        kind: "issue",
        owner: repository.owner,
        name: repository.name,
        number: selectedNumber,
      })
      .then((response) => {
        if (operation !== detailGeneration.current) return;
        if (response.kind === "unavailable") {
          setDetail(unavailableState(response));
          return;
        }
        if (response.kind !== "issue") {
          setDetail({ kind: "error", message: "GitHub returned an unexpected response." });
          return;
        }
        setDetail({
          kind: "ready",
          issue: response.issue,
          freshness: response.freshness,
        });
      })
      .catch((error: unknown) => {
        if (operation !== detailGeneration.current) return;
        setDetail({
          kind: "error",
          message: error instanceof Error ? error.message : "The issue could not be loaded.",
        });
      });
  }, [client, detailEpoch, repository, selectedNumber]);

  const loadMore = async () => {
    if (list.kind !== "ready" || list.endCursor === undefined) return;
    setLoadingMore(true);
    try {
      await loadList({ cursor: list.endCursor, append: true });
    } finally {
      setLoadingMore(false);
    }
  };

  const selectRepository = (row: GithubRepositoryRow) => {
    ++detailGeneration.current;
    setSelectedNumber(undefined);
    setDetail({ kind: "idle" });
    setRepository(row);
    setRepositoryPickerOpen(false);
  };

  return (
    <Surface ariaLabel="GitHub issues" className="github-issue-browser" measure="wide">
      <SurfaceHeader
        subtitle="Read-only GitHub issues from any repository this host can reach."
        title="Issues"
        {...(props.onClose === undefined ? {} : { onBack: props.onClose })}
      />

      {repository === undefined ? (
        // Nothing to browse until a repository is chosen, so the picker is
        // the page rather than a control on it.
        <div className="github-issue-browser__choose">
          <GitHubRepositoryPicker client={client} onSelect={selectRepository} />
        </div>
      ) : (
        <>
          <div aria-label="Issue controls" className="surface-toolbar" role="group">
            <OctantPopover
              align="start"
              className="github-issue-browser__repository-popup"
              onOpenChange={setRepositoryPickerOpen}
              open={repositoryPickerOpen}
              side="bottom"
              sideOffset={6}
              title="Choose a repository"
              trigger={
                <>
                  <FolderGit2 aria-hidden="true" size={14} strokeWidth={1.8} />
                  <span className="github-issue-browser__repository-name">
                    {repository.owner}/{repository.name}
                  </span>
                  <ChevronDown aria-hidden="true" size={14} strokeWidth={1.8} />
                </>
              }
              triggerClassName="github-issue-browser__repository"
              triggerLabel={`Repository: ${repository.owner}/${repository.name}`}
              triggerVariant="outline"
            >
              <GitHubRepositoryPicker
                client={client}
                onSelect={selectRepository}
                selectedNodeId={repository.nodeId}
              />
            </OctantPopover>

            <OctantToggleGroup<GithubIssueStateFilter>
              aria-label="Issue state"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected !== undefined && isIssueStateFilter(selected)) {
                  setStateFilter(selected);
                }
              }}
              value={[stateFilter]}
            >
              {STATE_FILTERS.map((filter) => (
                <OctantToggleGroupItem key={filter.value} value={filter.value}>
                  {filter.label}
                </OctantToggleGroupItem>
              ))}
            </OctantToggleGroup>

            <label className="surface-toolbar__search github-issue-browser__search">
              <Search aria-hidden="true" size={14} strokeWidth={1.7} />
              <span className="sr-only">Search GitHub issues</span>
              <OctantInput
                aria-label="Search GitHub issues"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title, #number, or author"
                type="search"
                value={search}
              />
            </label>
          </div>

          <div className="github-issue-browser__body">
            <div className="github-issue-browser__list-pane">
              {list.kind === "loading" ? (
                <p className="github-issue-browser__note" role="status">
                  Loading issues…
                </p>
              ) : null}

              {list.kind === "error" ? (
                <UnavailableNotice
                  message={list.message}
                  onRetry={() => void loadList()}
                  role="alert"
                />
              ) : null}
              {list.kind === "unavailable" ? (
                <UnavailableNotice
                  message={unavailableMessage(list)}
                  onRetry={() => void loadList()}
                  role="alert"
                />
              ) : null}

              {list.kind === "ready" ? (
                <>
                  {list.freshness.status === "stale" ? (
                    <div className="github-issue-browser__stale" role="status">
                      <span className="github-issue-browser__note">
                        Results may be stale —{" "}
                        {STALE_REASON_LABELS[list.freshness.staleReason ?? ""] ??
                          "the catalogue could not be refreshed."}
                      </span>
                      <OctantButton
                        onClick={() => void loadList()}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Refresh issues
                      </OctantButton>
                    </div>
                  ) : null}
                  {list.rows.length === 0 ? (
                    <p className="github-issue-browser__note" role="status">
                      No issues match.
                    </p>
                  ) : (
                    <ul aria-label="GitHub issues" className="github-issue-browser__list">
                      {list.rows.map((row) => (
                        <li key={row.number}>
                          <OctantButton
                            aria-current={selectedNumber === row.number ? "true" : undefined}
                            className="github-issue-browser__row"
                            onClick={() => setSelectedNumber(row.number)}
                            type="button"
                            variant="ghost"
                          >
                            <span className="github-issue-browser__row-title">
                              <span className="github-issue-browser__row-number">
                                #{row.number}
                              </span>{" "}
                              {row.title}
                            </span>
                            <span className="github-issue-browser__row-meta">
                              <IssueStateBadge state={row.state} />
                              <span>{row.author}</span>
                              <span title={absoluteTimeFormatter.format(new Date(row.updatedAt))}>
                                {relativeTimeLabel(row.updatedAt)}
                              </span>
                            </span>
                          </OctantButton>
                        </li>
                      ))}
                    </ul>
                  )}
                  {list.hasNextPage ? (
                    <OctantButton
                      className="github-issue-browser__more"
                      disabled={loadingMore}
                      onClick={() => void loadMore()}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {loadingMore ? "Loading more…" : "Load more issues"}
                    </OctantButton>
                  ) : null}
                  {paginationFailure === undefined ? null : (
                    <UnavailableNotice
                      message={paginationFailureMessage(paginationFailure)}
                      onRetry={() => void loadMore()}
                      role="alert"
                    />
                  )}
                </>
              ) : null}
            </div>

            <div className="github-issue-browser__detail-pane">
              <IssueDetailPane
                detail={detail}
                onRetry={() => setDetailEpoch((epoch) => epoch + 1)}
              />
            </div>
          </div>
        </>
      )}
    </Surface>
  );
}

function IssueStateBadge(props: { readonly state: GithubIssueRow["state"] }) {
  return (
    <OctantBadge className="github-issue-browser__state" data-state={props.state} variant="outline">
      {props.state === "open" ? "Open" : "Closed"}
    </OctantBadge>
  );
}

function IssueDetailPane(props: {
  readonly detail: IssueDetailState;
  readonly onRetry: () => void;
}) {
  const { detail } = props;
  if (detail.kind === "idle") {
    return (
      <p className="github-issue-browser__note github-issue-browser__placeholder" role="status">
        Select an issue to read it.
      </p>
    );
  }
  if (detail.kind === "loading") {
    return (
      <p className="github-issue-browser__note" role="status">
        Loading issue…
      </p>
    );
  }
  if (detail.kind === "error") {
    return <UnavailableNotice message={detail.message} onRetry={props.onRetry} role="alert" />;
  }
  if (detail.kind === "unavailable") {
    return (
      <UnavailableNotice
        message={unavailableMessage(detail)}
        onRetry={props.onRetry}
        role="alert"
      />
    );
  }

  const { issue, freshness } = detail;
  return (
    <article aria-label={`Issue #${issue.number}`} className="github-issue-browser__detail">
      {freshness.status === "stale" ? (
        <p className="github-issue-browser__note" role="status">
          Results may be stale —{" "}
          {STALE_REASON_LABELS[freshness.staleReason ?? ""] ??
            "the catalogue could not be refreshed."}
        </p>
      ) : null}
      <header className="github-issue-browser__detail-header">
        <h2 className="github-issue-browser__detail-title">
          <span className="github-issue-browser__row-number">#{issue.number}</span> {issue.title}
        </h2>
        <p className="github-issue-browser__row-meta">
          <IssueStateBadge state={issue.state} />
          <span>{issue.author}</span>
          <span title={absoluteTimeFormatter.format(new Date(issue.createdAt))}>
            opened {relativeTimeLabel(issue.createdAt)}
          </span>
          <span title={absoluteTimeFormatter.format(new Date(issue.updatedAt))}>
            updated {relativeTimeLabel(issue.updatedAt)}
          </span>
        </p>
        {issue.labels.length === 0 ? null : (
          <ul aria-label="Labels" className="github-issue-browser__labels">
            {issue.labels.map((label) => (
              <li key={label}>
                <OctantBadge variant="secondary">{label}</OctantBadge>
              </li>
            ))}
          </ul>
        )}
        {/* The address is shown, never followed: the pane reads GitHub, it
            does not send anyone there from inside a Code thread. */}
        <p className="github-issue-browser__url">{issue.url}</p>
      </header>
      <pre className="github-issue-browser__body-text">
        {issue.body === "" ? "No description." : issue.body}
      </pre>
      {issue.bodyTruncated ? (
        <p className="github-issue-browser__note" role="status">
          Body truncated.
        </p>
      ) : null}
      <section aria-label="Comments" className="github-issue-browser__comments-section">
        <h3 className="oct-section-label github-issue-browser__comments-title">
          Comments
          <span className="oct-meta">{issue.comments.length}</span>
        </h3>
        {issue.comments.length === 0 ? (
          <p className="github-issue-browser__note" role="status">
            No comments.
          </p>
        ) : (
          <ul className="github-issue-browser__comments">
            {issue.comments.map((comment, index) => (
              <li
                className="github-issue-browser__comment"
                key={`${comment.author}-${comment.createdAt}-${index}`}
              >
                <p className="github-issue-browser__row-meta">
                  <span className="github-issue-browser__comment-author">{comment.author}</span>
                  <span title={absoluteTimeFormatter.format(new Date(comment.createdAt))}>
                    {relativeTimeLabel(comment.createdAt)}
                  </span>
                </p>
                <pre className="github-issue-browser__body-text">{comment.body}</pre>
                {comment.truncated ? (
                  <p className="github-issue-browser__note" role="status">
                    Comment truncated.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function UnavailableNotice(props: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly role: "alert" | "status";
}) {
  return (
    <div className="github-issue-browser__stale">
      <p className="github-issue-browser__note" role={props.role}>
        {props.message}
      </p>
      <OctantButton onClick={props.onRetry} size="sm" type="button" variant="secondary">
        Retry
      </OctantButton>
    </div>
  );
}

function unavailableState(
  response: GithubCatalogueUnavailable,
): Extract<IssueListState, { readonly kind: "unavailable" }> {
  return {
    kind: "unavailable",
    reason: response.reason,
    ...(response.remediation === undefined ? {} : { remediation: response.remediation }),
    ...(response.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: response.retryAfterSeconds }),
  };
}

function unavailableMessage(state: {
  readonly reason: GithubCatalogueUnavailable["reason"];
  readonly remediation?: string;
  readonly retryAfterSeconds?: number;
}): string {
  const base = state.remediation ?? UNAVAILABLE_FALLBACKS[state.reason];
  if (state.retryAfterSeconds === undefined) return base;
  return `${base} Retry after ${state.retryAfterSeconds} seconds.`;
}

function paginationFailureMessage(failure: PaginationFailure): string {
  const detail = failure.kind === "unavailable" ? unavailableMessage(failure) : failure.message;
  return `Could not load more issues. ${detail}`;
}

function isIssueStateFilter(value: string): value is GithubIssueStateFilter {
  return value === "open" || value === "closed" || value === "all";
}
