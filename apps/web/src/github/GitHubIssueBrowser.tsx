import "../styles/github.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  GithubCatalogueFreshness,
  GithubCatalogueUnavailable,
  GithubIssueDetail,
  GithubIssueRow,
  GithubIssueStateFilter,
  GithubRepositoryRow,
} from "@octant/contracts";
import {
  ArrowLeft,
  ChevronDown,
  CircleCheck,
  CircleDot,
  FolderGit2,
  Search,
  SquarePen,
} from "../ui/icons";
import "../code/pull-request-page.css";
import { GitHubRepositoryPicker } from "../code/GitHubRepositoryPicker";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { Markdown } from "../markdown/Markdown";
import {
  WorkList,
  WorkListGroup,
  WorkListRow,
  WorkListSortMenu,
  type WorkListState,
} from "../surface/WorkList";
import {
  defaultBoardStorage,
  readStoredValue,
  writeStoredValue,
} from "../threadBoard/threadBoardState";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
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
 * single repository from the one chooser under the title. With no recent
 * repository the page asks for one instead of listing the whole catalogue.
 * Issue list and detail reads stay on the existing catalogue client. The page
 * is laid out as the Pull requests page is: a list column and a reading pane
 * that shares the pull request pane's columns.
 */
export interface GitHubIssueBrowserProps {
  readonly client: GithubClient;
  readonly onClose?: () => void;
  /**
   * The current Project's one GitHub remote. When the host has used it, the page
   * opens on that repository instead of on every recent one.
   */
  readonly projectRepository?: { readonly owner: string; readonly name: string };
  /** Hands the issue being read to a new Code thread as its context. */
  readonly onStartThread?: (issue: RepositoryIssueRow) => void;
  /** Injectable for tests; defaults to `window.localStorage` when available. */
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
}

const GROUP_STORAGE_KEY = "octant.github.issues.group-by-repository";

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
  const storage = props.storage ?? defaultBoardStorage();
  const [grouped, setGrouped] = useState<boolean>(
    () => readStoredValue(storage, GROUP_STORAGE_KEY, (value) => value) === "true",
  );
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
        const own = props.projectRepository;
        const preselected =
          own === undefined
            ? undefined
            : rows.find(
                (row) =>
                  row.owner.toLowerCase() === own.owner.toLowerCase() &&
                  row.name.toLowerCase() === own.name.toLowerCase(),
              );
        if (preselected !== undefined) {
          setRepository(preselected);
          setScope("repository");
          return;
        }
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
    // The Project's repository only decides the opening scope, once per client.
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

  // Repository order and grouping only mean something across repositories.
  const sortOptions = ISSUE_SORT_OPTIONS.filter(
    (option) => scope === "all" || option.id !== "repository",
  ).map((option) => ({ value: option.id, label: option.label }));
  const groupRows = grouped && scope === "all";
  const hasRecents = recents !== undefined && recents.length > 0;
  const browsing = scope === "all" || repository !== undefined;
  const repositoryLabel =
    repository !== undefined
      ? `${repository.owner}/${repository.name}`
      : hasRecents
        ? "All repositories"
        : "Choose a repository";
  const chooser = (
    <OctantPopover
      align="start"
      className="github-issue-browser__repository-popup"
      onOpenChange={setRepositoryPickerOpen}
      open={repositoryPickerOpen}
      side="bottom"
      title="Choose a repository"
      trigger={
        <>
          <span className="work-list__repository-words">{repositoryLabel}</span>
          <ChevronDown aria-hidden="true" size={14} />
        </>
      }
      triggerClassName="github-issue-browser__repository work-list__repository-trigger"
      triggerLabel={`Repository: ${repositoryLabel}`}
      triggerVariant="ghost"
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
          All repositories
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

  // One callback for every row, so re-rendering the page with the same rows
  // renders none of them again.
  const selectIssue = useCallback((row: RepositoryIssueRow) => {
    setSelected({ owner: row.owner, name: row.name, number: row.number });
  }, []);
  // Several repositories on one ungrouped list would read alike by bare name
  // (a/app, b/app), so the owner is named; a group head already says it.
  const qualifyRepository =
    scope === "all" &&
    !groupRows &&
    new Set(rows.map((row) => `${row.owner}/${row.name}`)).size > 1;
  const renderRows = (list: ReadonlyArray<RepositoryIssueRow>, label: string, qualify: boolean) => (
    <WorkList ariaLabel={label}>
      {list.map((row) => (
        <li key={`${row.owner}/${row.name}#${row.number}`}>
          <IssueRow
            onSelect={selectIssue}
            qualifyRepository={qualify}
            repositoryShown={scope === "all"}
            row={row}
            selected={
              selected !== undefined &&
              selected.owner === row.owner &&
              selected.name === row.name &&
              selected.number === row.number
            }
          />
        </li>
      ))}
    </WorkList>
  );

  const stateChips = (
    <div aria-label="Issue state" className="pr-page__chips" role="group">
      {STATE_FILTERS.map((filter) => (
        <OctantButton
          aria-pressed={stateFilter === filter.value}
          className="pr-page__chip"
          key={filter.value}
          onClick={() => setStateFilter(filter.value)}
          type="button"
          variant="bare"
        >
          {filter.label}
        </OctantButton>
      ))}
    </div>
  );

  const listContent =
    scope !== undefined && !browsing ? (
      // Nothing to list until a repository is chosen; the page says so in
      // one panel rather than opening on the whole catalogue.
      <div className="github-issue-browser__empty">
        <FolderGit2 aria-hidden="true" size={20} />
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
      <div className="github-issue-browser__list-body">
        {listLoading ? (
          <p className="github-issue-browser__note" role="status">
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
              <p className="github-issue-browser__note" role="status">
                No issues match.
              </p>
            ) : groupRows ? (
              <div className="work-list__groups">
                {groupIssuesByRepository(rows).map((group) => (
                  <WorkListGroup count={group.rows.length} key={group.title} title={group.title}>
                    {renderRows(group.rows, group.title, false)}
                  </WorkListGroup>
                ))}
              </div>
            ) : (
              renderRows(rows, "GitHub issues", qualifyRepository)
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
    );

  return (
    <section
      aria-label="GitHub issues"
      className="pr-page github-issue-browser"
      data-detail={selected === undefined ? "none" : "open"}
      data-empty={scope !== undefined && !browsing ? "true" : undefined}
    >
      <div className="pr-page__frame">
        <div className="pr-page__list">
          <header className="pr-page__list-head">
            {/* Back leads the title, as it does on every destination. */}
            {props.onClose === undefined ? null : (
              <OctantButton
                aria-label="Back to workspace"
                className="work-list__icon-button pr-page__list-back"
                onClick={props.onClose}
                size="icon"
                type="button"
                variant="ghost"
              >
                <ArrowLeft aria-hidden="true" size={16} />
              </OctantButton>
            )}
            <h1 className="pr-page__list-title">Issues</h1>
            <div className="pr-page__list-actions">
              {browsing ? (
                <WorkListSortMenu
                  label="Sort issues"
                  onValueChange={setSort}
                  options={sortOptions}
                  value={sort}
                  {...(scope === "all"
                    ? {
                        grouped,
                        onGroupedChange: (next: boolean) => {
                          setGrouped(next);
                          writeStoredValue(storage, GROUP_STORAGE_KEY, String(next));
                        },
                      }
                    : {})}
                />
              ) : null}
            </div>
            <div className="pr-page__list-sub">
              <span className="oct-meta pr-page__list-count">
                {listReady ? issueCountCopy(rows.length) : ""}
              </span>
              {chooser}
            </div>
          </header>
          {browsing ? (
            <>
              <div aria-label="Issue controls" className="surface-toolbar" role="group">
                <label className="surface-toolbar__search code-project-pull-requests__search github-issue-browser__search">
                  <Search aria-hidden="true" size={14} />
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
              {stateChips}
            </>
          ) : null}
          {listContent}
        </div>
        <div className="pr-page__detail">
          {selected === undefined ? null : (
            <div className="pr-page__detail-back">
              <OctantButton onClick={clearSelection} size="sm" type="button" variant="ghost">
                <ArrowLeft aria-hidden="true" size={14} />
                Issues
              </OctantButton>
            </div>
          )}
          <IssueDetailPane
            detail={detail}
            onRetry={() => setDetailEpoch((epoch) => epoch + 1)}
            {...(props.onStartThread === undefined ? {} : { onStartThread: props.onStartThread })}
            {...(selected === undefined ? {} : { selected })}
          />
        </div>
      </div>
    </section>
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
    <OctantBadge
      className="github-issue-browser__state"
      data-state={props.state}
      variant={props.state === "open" ? "success" : "secondary"}
    >
      {props.state === "open" ? "Open" : "Closed"}
    </OctantBadge>
  );
}

const IssueRow = memo(function IssueRow(props: {
  readonly row: RepositoryIssueRow;
  readonly selected: boolean;
  readonly repositoryShown: boolean;
  readonly qualifyRepository: boolean;
  readonly onSelect: (row: RepositoryIssueRow) => void;
}) {
  const { row } = props;
  return (
    <WorkListRow
      author={row.author}
      id={`${row.owner}/${row.name}#${row.number}`}
      number={row.number}
      onSelect={() => props.onSelect(row)}
      {...(props.repositoryShown
        ? { repository: props.qualifyRepository ? `${row.owner}/${row.name}` : row.name }
        : {})}
      selected={props.selected}
      selection="current"
      state={issueStateGlyph(row.state)}
      title={row.title}
      updatedAt={row.updatedAt}
    />
  );
});

function issueStateGlyph(state: GithubIssueRow["state"]): WorkListState {
  return state === "open"
    ? { label: "Open", tone: "open", Icon: CircleDot }
    : { label: "Closed", tone: "closed", Icon: CircleCheck };
}

function groupIssuesByRepository(rows: ReadonlyArray<RepositoryIssueRow>): ReadonlyArray<{
  readonly title: string;
  readonly rows: ReadonlyArray<RepositoryIssueRow>;
}> {
  const groups: Array<{ title: string; rows: RepositoryIssueRow[] }> = [];
  for (const row of rows) {
    const title = `${row.owner}/${row.name}`;
    const existing = groups.find((group) => group.title === title);
    if (existing === undefined) groups.push({ title, rows: [row] });
    else existing.rows.push(row);
  }
  return groups;
}

function issueCountCopy(count: number): string {
  return count === 1 ? "1 issue" : `${String(count)} issues`;
}

function IssueDetailPane(props: {
  readonly detail: IssueDetailState;
  readonly selected?: SelectedIssue;
  readonly onRetry: () => void;
  readonly onStartThread?: (issue: RepositoryIssueRow) => void;
}) {
  const { detail, selected } = props;
  if (detail.kind === "idle") {
    return <OctantEmpty layout="line" title="Select an issue to read it." />;
  }
  if (detail.kind === "loading") {
    return <OctantEmpty layout="line" title="Loading issue…" />;
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
  // The reading column is the pull request pane's: the title and the text in one
  // column, the facts beside it in another, and the one action above the facts.
  return (
    <article
      aria-label={`Issue #${issue.number}`}
      className="pr-detail github-issue-browser__detail"
    >
      <div className="pr-detail__bar">
        <span />
        <div className="pr-detail__tools">
          {startThread === undefined || selected === undefined ? null : (
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
              <SquarePen aria-hidden="true" size={14} />
              Start a Code thread
            </OctantButton>
          )}
        </div>
      </div>
      {freshness.status === "stale" ? (
        <p className="github-issue-browser__note pr-detail__notice" role="status">
          Results may be stale —{" "}
          {STALE_REASON_LABELS[freshness.staleReason ?? ""] ??
            "the catalogue could not be refreshed."}
        </p>
      ) : null}
      <div className="pr-detail__body" data-tab="summary">
        <header className="pr-detail__head">
          <p className="pr-detail__kicker">
            <IssueStateBadge state={issue.state} />
            <span className="oct-meta">
              {selected === undefined ? "" : `${selected.owner}/${selected.name} `}#{issue.number}
            </span>
          </p>
          <h1 className="oct-page-title pr-detail__title">{issue.title}</h1>
          <p className="pr-detail__meta">
            <span>{issue.author}</span>
            <span title={absoluteTimeFormatter.format(new Date(issue.updatedAt))}>
              {relativeTimeLabel(issue.updatedAt)}
            </span>
          </p>
        </header>

        <aside aria-label="Issue facts" className="pr-detail__status">
          <section aria-label="Opened" className="pr-detail__group">
            <h2 className="oct-nav-group">Opened</h2>
            <p className="pr-detail__line">
              <span title={absoluteTimeFormatter.format(new Date(issue.createdAt))}>
                {issue.author} {relativeTimeLabel(issue.createdAt)}
              </span>
            </p>
          </section>
          {issue.labels.length === 0 ? null : (
            <section aria-label="Labels" className="pr-detail__group">
              <h2 className="oct-nav-group">Labels</h2>
              <ul aria-label="Labels" className="github-issue-browser__labels">
                {issue.labels.map((label) => (
                  <li key={label}>
                    <OctantBadge variant="secondary">{label}</OctantBadge>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>

        <div className="pr-detail__content">
          {issue.body === "" ? (
            <p className="pr-detail__quiet" role="status">
              No description.
            </p>
          ) : (
            <Markdown body={issue.body} className="pr-detail__prose" skipHtml />
          )}
          {issue.bodyTruncated ? (
            <p className="pr-detail__quiet" role="status">
              Body truncated.
            </p>
          ) : null}
          {/* The address is shown as text: the pane reads GitHub, it does not
              send anyone there from inside a Code thread. */}
          <p className="github-issue-browser__url">{issue.url}</p>
          <section aria-label="Comments" className="github-issue-browser__comments-section">
            <h2 className="oct-nav-group">
              Comments <span className="oct-meta">{issue.comments.length}</span>
            </h2>
            {issue.comments.length === 0 ? (
              <p className="pr-detail__quiet" role="status">
                No comments.
              </p>
            ) : (
              <ol className="pr-detail__timeline">
                {issue.comments.map((comment, index) => (
                  <li key={`${comment.author}-${comment.createdAt}-${index}`}>
                    <p className="pr-detail__who">
                      <strong>{comment.author}</strong>
                      <span
                        className="oct-meta"
                        title={absoluteTimeFormatter.format(new Date(comment.createdAt))}
                      >
                        {relativeTimeLabel(comment.createdAt)}
                      </span>
                    </p>
                    <Markdown body={comment.body} className="pr-detail__prose" skipHtml />
                    {comment.truncated ? (
                      <p className="pr-detail__quiet" role="status">
                        Comment truncated.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </article>
  );
}

function UnavailableNotice(props: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly role: "alert" | "status";
}) {
  return (
    <OctantAlert
      action={
        <OctantButton onClick={props.onRetry} size="sm" type="button" variant="secondary">
          Retry
        </OctantButton>
      }
      className="github-issue-browser__stale"
      role={props.role}
      tone={props.role === "alert" ? "danger" : "neutral"}
    >
      <p className="github-issue-browser__note">{props.message}</p>
    </OctantAlert>
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
