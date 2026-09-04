import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  GithubCatalogueFreshness,
  GithubCatalogueUnavailable,
  GithubIssueDetail,
  GithubIssueRow,
  GithubIssueStateFilter,
  GithubRepositoryRow,
} from "@octant/contracts";
import { ChevronDown, CircleCheck, CircleDot, FolderGit2, Search, SquarePen } from "lucide-react";
import { GitHubRepositoryPicker } from "../code/GitHubRepositoryPicker";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { Surface, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { describeGithubRemediation } from "./githubRemediation";
import {
  DEFAULT_ISSUE_SORT,
  ISSUE_SORT_OPTIONS,
  isIssueSort,
  readIssuesAcrossRepositories,
  sortIssueRows,
  type IssueSort,
  type IssuesAcrossRepositories,
  type RepositoryIssueRow,
} from "./readIssuesAcrossRepositories";

/**
 * Host-scoped, read-only GitHub issue browser. It opens on every repository
 * the host has recently used, merged into one sorted list, and narrows to a
 * single repository from the one chooser on the toolbar. With no recent
 * repository the page asks for one instead of listing the whole catalogue.
 * Issue list and detail reads stay on the existing catalogue client. The
 * pane never renders markdown or followable links.
 */
export interface GitHubIssueBrowserProps {
  readonly client: GithubClient;
  readonly onClose?: () => void;
  /** Hands the issue being read to a new Code thread as its context. */
  readonly onStartThread?: (issue: RepositoryIssueRow) => void;
}

type IssueScope = "all" | "repository";

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

type AcrossState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: IssuesAcrossRepositories };

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

interface SelectedIssue {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

const PAGE_SIZE = 30;
const ACROSS_PAGE_SIZE = 20;
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
  // Recent repositories decide the opening scope: with any, the page opens on
  // all of them; with none, the repository picker is the page.
  const [recents, setRecents] = useState<ReadonlyArray<GithubRepositoryRow>>();
  const [scope, setScope] = useState<IssueScope>();
  const [repository, setRepository] = useState<GithubRepositoryRow>();
  const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false);
  const [stateFilter, setStateFilter] = useState<GithubIssueStateFilter>("open");
  const [sort, setSort] = useState<IssueSort>(DEFAULT_ISSUE_SORT);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const [list, setList] = useState<IssueListState>({ kind: "idle" });
  const [across, setAcross] = useState<AcrossState>({ kind: "idle" });
  const [acrossEpoch, setAcrossEpoch] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationFailure, setPaginationFailure] = useState<PaginationFailure>();
  const [selected, setSelected] = useState<SelectedIssue>();
  const [detail, setDetail] = useState<IssueDetailState>({ kind: "idle" });
  const [detailEpoch, setDetailEpoch] = useState(0);
  const listGeneration = useRef(0);
  const acrossGeneration = useRef(0);
  const detailGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    client
      .readCatalogue({ kind: "recent-repositories" })
      .then((response) => {
        if (cancelled) return;
        const rows = response.kind === "recent-repositories" ? response.rows : [];
        setRecents(rows);
        setScope(rows.length > 0 ? "all" : "repository");
      })
      .catch(() => {
        if (cancelled) return;
        setRecents([]);
        setScope("repository");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const clearSelection = () => {
    ++detailGeneration.current;
    setSelected(undefined);
    setDetail({ kind: "idle" });
  };

  const loadList = useCallback(
    async (options: { readonly cursor?: string; readonly append?: boolean } = {}) => {
      if (repository === undefined) return;
      const operation = options.append === true ? listGeneration.current : ++listGeneration.current;
      if (options.append !== true) {
        ++detailGeneration.current;
        setPaginationFailure(undefined);
        setList({ kind: "loading" });
        setSelected(undefined);
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
    if (scope !== "repository" || repository === undefined) {
      setList({ kind: "idle" });
      return;
    }
    void loadList();
  }, [loadList, repository, scope]);

  useEffect(() => {
    if (scope !== "all" || recents === undefined || recents.length === 0) {
      setAcross({ kind: "idle" });
      return;
    }
    const operation = ++acrossGeneration.current;
    ++detailGeneration.current;
    setAcross({ kind: "loading" });
    setSelected(undefined);
    setDetail({ kind: "idle" });
    void readIssuesAcrossRepositories(client, recents, {
      state: stateFilter,
      search: debouncedSearch,
      pageSize: ACROSS_PAGE_SIZE,
    }).then((result) => {
      if (operation !== acrossGeneration.current) return;
      setAcross({ kind: "ready", result });
    });
  }, [acrossEpoch, client, debouncedSearch, recents, scope, stateFilter]);

  useEffect(() => {
    if (selected === undefined) {
      setDetail({ kind: "idle" });
      return;
    }
    const operation = ++detailGeneration.current;
    setDetail({ kind: "loading" });
    void client
      .readCatalogue({
        kind: "issue",
        owner: selected.owner,
        name: selected.name,
        number: selected.number,
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
  }, [client, detailEpoch, selected]);

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
    clearSelection();
    setRepository(row);
    changeScope("repository");
    setRepositoryPickerOpen(false);
  };

  const selectAllRecent = () => {
    clearSelection();
    setRepository(undefined);
    changeScope("all");
    setRepositoryPickerOpen(false);
  };

  const changeScope = (next: IssueScope) => {
    if (next === scope) return;
    clearSelection();
    setScope(next);
    // Sorting by repository only exists across repositories. Carrying it into
    // the one-repository scope left the sort trigger with no matching option
    // and so no label at all.
    if (next !== "all" && sort === "repository") setSort(DEFAULT_ISSUE_SORT);
  };

  // Both scopes end in one sorted list of attributed rows, so the list below
  // renders one shape whichever source filled it.
  const rows = useMemo((): ReadonlyArray<RepositoryIssueRow> => {
    if (scope === "all" && across.kind === "ready") {
      return sortIssueRows(across.result.rows, sort);
    }
    if (scope === "repository" && list.kind === "ready" && repository !== undefined) {
      return sortIssueRows(
        list.rows.map((row) => ({ ...row, owner: repository.owner, name: repository.name })),
        sort,
      );
    }
    return [];
  }, [across, list, repository, scope, sort]);

  const hasRecents = recents !== undefined && recents.length > 0;
  const browsing = scope === "all" || repository !== undefined;
  const repositoryLabel =
    repository !== undefined
      ? `${repository.owner}/${repository.name}`
      : hasRecents
        ? "All recent repositories"
        : "Choose a repository";
  const chooser = (
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
          <span className="github-issue-browser__repository-name">{repositoryLabel}</span>
          <ChevronDown aria-hidden="true" size={14} strokeWidth={1.8} />
        </>
      }
      triggerClassName="github-issue-browser__repository"
      triggerLabel={`Repository: ${repositoryLabel}`}
      triggerVariant="outline"
    >
      {hasRecents ? (
        <OctantButton
          aria-pressed={scope === "all"}
          className="github-issue-browser__all-recent"
          onClick={selectAllRecent}
          size="sm"
          type="button"
          variant={scope === "all" ? "secondary" : "ghost"}
        >
          All recent repositories
          <span className="oct-meta">{recents.length}</span>
        </OctantButton>
      ) : null}
      <GitHubRepositoryPicker
        client={client}
        onSelect={selectRepository}
        {...(repository === undefined ? {} : { selectedNodeId: repository.nodeId })}
      />
    </OctantPopover>
  );

  const listLoading =
    scope === undefined ||
    (scope === "all" && across.kind !== "ready") ||
    (scope === "repository" && list.kind === "loading");
  const listReady =
    (scope === "all" && across.kind === "ready") ||
    (scope === "repository" && list.kind === "ready");
  const staleReason =
    scope === "repository" && list.kind === "ready" && list.freshness.status === "stale"
      ? (STALE_REASON_LABELS[list.freshness.staleReason ?? ""] ??
        "the catalogue could not be refreshed.")
      : scope === "all" && across.kind === "ready" && across.result.stale
        ? "at least one repository could not be refreshed."
        : undefined;
  const reload = () => {
    if (scope === "all") setAcrossEpoch((epoch) => epoch + 1);
    else void loadList();
  };

  return (
    <Surface ariaLabel="GitHub issues" className="github-issue-browser" measure="wide">
      <SurfaceHeader
        subtitle="Read-only GitHub issues from any repository this host can reach."
        title="Issues"
        {...(props.onClose === undefined ? {} : { onBack: props.onClose })}
      />

      <div aria-label="Issue controls" className="surface-toolbar" role="group">
        {chooser}
        {browsing ? (
          <>
            <OctantToggleGroup<GithubIssueStateFilter>
              aria-label="Issue state"
              onValueChange={(value) => {
                const selectedFilter = value[0];
                if (selectedFilter !== undefined && isIssueStateFilter(selectedFilter)) {
                  setStateFilter(selectedFilter);
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

            <OctantSelectField
              aria-label="Sort issues"
              onValueChange={(value) => {
                if (isIssueSort(value)) setSort(value);
              }}
              options={ISSUE_SORT_OPTIONS.filter(
                (option) => scope === "all" || option.id !== "repository",
              )}
              triggerClassName="github-issue-browser__sort"
              value={sort}
            />

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
          </>
        ) : null}
      </div>

      {scope !== undefined && !browsing ? (
        // Nothing to list until a repository is chosen; the page says so in
        // one panel rather than opening on the whole catalogue.
        <div className="github-issue-browser__empty">
          <FolderGit2 aria-hidden="true" size={20} strokeWidth={1.5} />
          <p className="github-issue-browser__empty-title">Choose a repository</p>
          <p className="github-issue-browser__note">
            Issues are read from any repository this host can reach. Repositories a Code thread has
            used are listed together here automatically.
          </p>
          <OctantButton
            onClick={() => setRepositoryPickerOpen(true)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Choose a repository
          </OctantButton>
        </div>
      ) : (
        <div className="github-issue-browser__body">
          <div className="github-issue-browser__list-pane">
            {listLoading ? (
              <p className="github-issue-browser__note github-issue-browser__pad" role="status">
                Loading issues…
              </p>
            ) : null}

            {scope === "repository" && list.kind === "error" ? (
              <UnavailableNotice message={list.message} onRetry={reload} role="alert" />
            ) : null}
            {scope === "repository" && list.kind === "unavailable" ? (
              <UnavailableNotice message={unavailableMessage(list)} onRetry={reload} role="alert" />
            ) : null}

            {listReady ? (
              <>
                {staleReason === undefined ? null : (
                  <div className="github-issue-browser__stale" role="status">
                    <span className="github-issue-browser__note">
                      Results may be stale — {staleReason}
                    </span>
                    <OctantButton onClick={reload} size="sm" type="button" variant="ghost">
                      Refresh issues
                    </OctantButton>
                  </div>
                )}
                {scope === "all" && across.kind === "ready" ? (
                  <AcrossNotes result={across.result} onRetry={reload} />
                ) : null}
                {rows.length === 0 ? (
                  <p className="github-issue-browser__note github-issue-browser__pad" role="status">
                    No issues match.
                  </p>
                ) : (
                  <ul aria-label="GitHub issues" className="github-issue-browser__list">
                    {rows.map((row) => {
                      const current =
                        selected !== undefined &&
                        selected.owner === row.owner &&
                        selected.name === row.name &&
                        selected.number === row.number;
                      return (
                        <li key={`${row.owner}/${row.name}#${row.number}`}>
                          <OctantButton
                            aria-current={current ? "true" : undefined}
                            className="github-issue-browser__row"
                            onClick={() =>
                              setSelected({
                                owner: row.owner,
                                name: row.name,
                                number: row.number,
                              })
                            }
                            type="button"
                            variant="ghost"
                          >
                            <IssueStateIcon state={row.state} />
                            <span className="github-issue-browser__row-copy">
                              <span className="github-issue-browser__row-title">
                                <span className="github-issue-browser__row-number">
                                  #{row.number}
                                </span>{" "}
                                {row.title}
                              </span>
                              <span className="github-issue-browser__row-meta">
                                {scope === "all" ? (
                                  <span className="github-issue-browser__row-repository">
                                    {row.owner}/{row.name}
                                  </span>
                                ) : null}
                                <span>{row.author}</span>
                                <span title={absoluteTimeFormatter.format(new Date(row.updatedAt))}>
                                  {relativeTimeLabel(row.updatedAt)}
                                </span>
                              </span>
                            </span>
                          </OctantButton>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {scope === "repository" && list.kind === "ready" && list.hasNextPage ? (
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
              {...(props.onStartThread === undefined ? {} : { onStartThread: props.onStartThread })}
              {...(selected === undefined ? {} : { selected })}
            />
          </div>
        </div>
      )}
    </Surface>
  );
}

/**
 * The cross-repository list is a bounded snapshot. Say which repositories
 * refused and which hold more than the page shown, so a missing issue is
 * explained rather than silently absent.
 */
function AcrossNotes(props: {
  readonly result: IssuesAcrossRepositories;
  readonly onRetry: () => void;
}) {
  const { result } = props;
  if (result.refused.length === 0 && result.truncated.length === 0) return null;
  return (
    <div className="github-issue-browser__across-notes">
      {result.refused.map((refusal) => (
        <UnavailableNotice
          key={`${refusal.owner}/${refusal.name}`}
          message={`${refusal.owner}/${refusal.name}: ${refusal.message}`}
          onRetry={props.onRetry}
          role="alert"
        />
      ))}
      {result.truncated.length === 0 ? null : (
        <p className="github-issue-browser__note" role="status">
          Showing the newest {ACROSS_PAGE_SIZE} from {result.truncated.join(", ")}. Choose one
          repository to page through the rest.
        </p>
      )}
    </div>
  );
}

function IssueStateBadge(props: { readonly state: GithubIssueRow["state"] }) {
  return (
    <OctantBadge className="github-issue-browser__state" data-state={props.state} variant="outline">
      {props.state === "open" ? "Open" : "Closed"}
    </OctantBadge>
  );
}

function IssueStateIcon(props: { readonly state: GithubIssueRow["state"] }) {
  const Icon = props.state === "open" ? CircleDot : CircleCheck;
  return (
    <Icon
      aria-label={props.state === "open" ? "Open" : "Closed"}
      className="github-issue-browser__row-state"
      data-state={props.state}
      role="img"
      size={16}
      strokeWidth={1.8}
    />
  );
}

function IssueDetailPane(props: {
  readonly detail: IssueDetailState;
  readonly selected?: SelectedIssue;
  readonly onRetry: () => void;
  readonly onStartThread?: (issue: RepositoryIssueRow) => void;
}) {
  const { detail, selected } = props;
  if (detail.kind === "idle") {
    return (
      <div className="github-issue-browser__placeholder" role="status">
        <CircleDot aria-hidden="true" size={20} strokeWidth={1.5} />
        <p className="github-issue-browser__note">Select an issue to read it.</p>
      </div>
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
  const startThread = props.onStartThread;
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
        <p className="github-issue-browser__detail-kicker">
          {selected === undefined ? null : (
            <span className="github-issue-browser__row-repository">
              {selected.owner}/{selected.name}
            </span>
          )}
          <span className="github-issue-browser__row-number">#{issue.number}</span>
        </p>
        <h2 className="github-issue-browser__detail-title">{issue.title}</h2>
        <p className="github-issue-browser__row-meta">
          <IssueStateBadge state={issue.state} />
          <span>
            {issue.author} opened{" "}
            <span title={absoluteTimeFormatter.format(new Date(issue.createdAt))}>
              {relativeTimeLabel(issue.createdAt)}
            </span>
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
        {startThread === undefined || selected === undefined ? null : (
          <div className="github-issue-browser__detail-actions">
            <OctantButton
              onClick={() =>
                startThread({
                  owner: selected.owner,
                  name: selected.name,
                  number: issue.number,
                  title: issue.title,
                  state: issue.state,
                  author: issue.author,
                  updatedAt: issue.updatedAt,
                  url: issue.url,
                })
              }
              size="sm"
              type="button"
              variant="secondary"
            >
              <SquarePen aria-hidden="true" size={14} strokeWidth={1.8} />
              Start a Code thread
            </OctantButton>
          </div>
        )}
      </header>
      <div className="github-issue-browser__reader">
        <pre className="github-issue-browser__body-text">
          {issue.body === "" ? "No description." : issue.body}
        </pre>
        {issue.bodyTruncated ? (
          <p className="github-issue-browser__note" role="status">
            Body truncated.
          </p>
        ) : null}
        {/* The address is shown, never followed: the pane reads GitHub, it
            does not send anyone there from inside a Code thread. */}
        <p className="github-issue-browser__url">{issue.url}</p>
      </div>
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
                <p className="github-issue-browser__row-meta github-issue-browser__comment-head">
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
  const base =
    state.remediation === undefined
      ? UNAVAILABLE_FALLBACKS[state.reason]
      : describeGithubRemediation(state.remediation);
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
