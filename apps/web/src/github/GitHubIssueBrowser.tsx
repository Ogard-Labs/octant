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
import { GitHubRepositoryPicker } from "../code/GitHubRepositoryPicker";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";

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
  const [changingRepository, setChangingRepository] = useState(false);
  const [stateFilter, setStateFilter] = useState<GithubIssueStateFilter>("open");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const [list, setList] = useState<IssueListState>({ kind: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
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
          if (options.append === true) return;
          setList(unavailableState(response));
          return;
        }
        if (response.kind !== "issues") {
          if (options.append === true) return;
          setList({ kind: "error", message: "GitHub returned an unexpected response." });
          return;
        }
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
        if (options.append === true) return;
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
    setRepository(row);
    setChangingRepository(false);
  };

  return (
    <section aria-label="GitHub issues" className="github-issue-browser">
      <header className="github-issue-browser__header">
        <div className="github-issue-browser__identity">
          <h1 className="github-issue-browser__title">Issues</h1>
          <p className="github-issue-browser__subtitle">
            Read-only GitHub issues from any accessible repository.
          </p>
        </div>
        {props.onClose === undefined ? null : (
          <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
            Back to workspace
          </OctantButton>
        )}
      </header>

      <div className="github-issue-browser__body">
        <div className="github-issue-browser__list-pane">
          {repository === undefined || changingRepository ? (
            <GitHubRepositoryPicker
              client={client}
              onSelect={selectRepository}
              {...(repository === undefined ? {} : { selectedNodeId: repository.nodeId })}
            />
          ) : (
            <div className="github-issue-browser__repository">
              <p className="github-issue-browser__repository-name">
                {repository.owner}/{repository.name}
              </p>
              <OctantButton
                onClick={() => setChangingRepository(true)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Change repository
              </OctantButton>
            </div>
          )}

          {repository === undefined ? null : (
            <>
              <div className="github-issue-browser__toolbar">
                <label className="github-issue-browser__state">
                  <span>State</span>
                  <OctantNativeSelect
                    aria-label="Issue state"
                    onChange={(event) => {
                      if (isIssueStateFilter(event.target.value)) {
                        setStateFilter(event.target.value);
                      }
                    }}
                    value={stateFilter}
                  >
                    {STATE_FILTERS.map((filter) => (
                      <option key={filter.value} value={filter.value}>
                        {filter.label}
                      </option>
                    ))}
                  </OctantNativeSelect>
                </label>
                <OctantInput
                  aria-label="Search GitHub issues"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search title, #number, or author…"
                  type="search"
                  value={search}
                />
              </div>

              {list.kind === "loading" ? <p role="status">Loading issues…</p> : null}

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
                    <p className="github-issue-browser__note" role="status">
                      Results may be stale —{" "}
                      {STALE_REASON_LABELS[list.freshness.staleReason ?? ""] ??
                        "the catalogue could not be refreshed."}{" "}
                      Refresh to retry.
                    </p>
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
                              #{row.number} {row.title}
                            </span>
                            <span className="github-issue-browser__row-meta">
                              <span>{row.state}</span>
                              <span>{row.author}</span>
                              <span>{row.updatedAt}</span>
                            </span>
                          </OctantButton>
                        </li>
                      ))}
                    </ul>
                  )}
                  {list.hasNextPage ? (
                    <OctantButton
                      disabled={loadingMore}
                      onClick={() => void loadMore()}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {loadingMore ? "Loading more…" : "Load more issues"}
                    </OctantButton>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>

        <div className="github-issue-browser__detail-pane">
          <IssueDetailPane detail={detail} onRetry={() => setDetailEpoch((epoch) => epoch + 1)} />
        </div>
      </div>
    </section>
  );
}

function IssueDetailPane(props: {
  readonly detail: IssueDetailState;
  readonly onRetry: () => void;
}) {
  const { detail } = props;
  if (detail.kind === "idle") {
    return (
      <p className="github-issue-browser__note" role="status">
        Select an issue to read its details.
      </p>
    );
  }
  if (detail.kind === "loading") {
    return <p role="status">Loading issue…</p>;
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
          #{issue.number} {issue.title}
        </h2>
        <p className="github-issue-browser__row-meta">
          <span>{issue.state}</span>
          <span>{issue.author}</span>
          <span>opened {issue.createdAt}</span>
          <span>updated {issue.updatedAt}</span>
        </p>
        <p className="github-issue-browser__url">{issue.url}</p>
        {issue.labels.length === 0 ? null : (
          <ul aria-label="Labels" className="github-issue-browser__labels">
            {issue.labels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        )}
      </header>
      <pre className="github-issue-browser__body-text">
        {issue.body === "" ? "No description." : issue.body}
      </pre>
      {issue.bodyTruncated ? (
        <p className="github-issue-browser__note" role="status">
          Body truncated.
        </p>
      ) : null}
      <h3 className="github-issue-browser__comments-title">Comments</h3>
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
                <span>{comment.author}</span>
                <span>{comment.createdAt}</span>
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
    </article>
  );
}

function UnavailableNotice(props: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly role: "alert" | "status";
}) {
  return (
    <>
      <p role={props.role}>{props.message}</p>
      <OctantButton onClick={props.onRetry} size="sm" type="button" variant="secondary">
        Retry
      </OctantButton>
    </>
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

function isIssueStateFilter(value: string): value is GithubIssueStateFilter {
  return value === "open" || value === "closed" || value === "all";
}
