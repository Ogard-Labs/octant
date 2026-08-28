import type {
  LinearIssueDetail,
  LinearIssueFilterOption,
  LinearIssueFilterOptions,
  LinearIssueGetInput,
  LinearIssueListFilter,
  LinearIssueListInput,
  LinearIssueListPage,
  LinearIssueRow,
} from "@octant/contracts/linear-issues";
import { decodeLinearIssueListInput } from "@octant/contracts/linear-issues";
import { CircleDot, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { ShellState } from "../shell/ShellState";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import {
  OctantEmptyStateActions,
  OctantEmptyStateCopy,
  OctantEmptyStateRoot,
  OctantEmptyStateTitle,
} from "../ui/base/OctantEmptyState";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface LinearIssueBrowserProps {
  readonly listIssues: (input?: LinearIssueListInput) => Promise<LinearIssueListPage>;
  readonly getIssue: (input: LinearIssueGetInput) => Promise<LinearIssueDetail>;
  readonly listIssueFilters: () => Promise<LinearIssueFilterOptions>;
  readonly onClose?: () => void;
  readonly isNarrow?: boolean;
}

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly page: LinearIssueListPage }
  | { readonly status: "loading-more"; readonly page: LinearIssueListPage }
  | { readonly status: "error"; readonly message: string; readonly page?: LinearIssueListPage };

type DetailState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly id: string }
  | { readonly status: "ready"; readonly detail: LinearIssueDetail }
  | { readonly status: "error"; readonly message: string };

const ALL = "all";

export function LinearIssueBrowser(props: LinearIssueBrowserProps) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const [teamId, setTeamId] = useState(ALL);
  const [stateId, setStateId] = useState(ALL);
  const [assigneeId, setAssigneeId] = useState(ALL);
  const [projectId, setProjectId] = useState(ALL);
  const [filters, setFilters] = useState<LinearIssueFilterOptions>();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  const listIssuesRef = useRef(props.listIssues);
  const getIssueRef = useRef(props.getIssue);
  const listIssueFiltersRef = useRef(props.listIssueFilters);
  useEffect(() => {
    listIssuesRef.current = props.listIssues;
    getIssueRef.current = props.getIssue;
    listIssueFiltersRef.current = props.listIssueFilters;
  });

  const query = useMemo(
    () => buildQuery(debouncedSearch, teamId, stateId, assigneeId, projectId),
    [debouncedSearch, teamId, stateId, assigneeId, projectId],
  );

  useEffect(() => {
    let active = true;
    void listIssueFiltersRef.current().then(
      (options) => {
        if (active) setFilters(options);
      },
      () => {
        if (active) setFilters(undefined);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setList({ status: "loading" });
    setDetail({ status: "idle" });
    listIssuesRef.current(query).then(
      (page) => {
        if (active) setList({ status: "ready", page });
      },
      (error: unknown) => {
        if (active) setList({ status: "error", message: failureMessage(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [query]);

  async function loadMore(): Promise<void> {
    const page = list.status === "ready" || list.status === "loading-more" ? list.page : undefined;
    if (page === undefined || !page.hasNextPage || page.endCursor === undefined) return;
    setList({ status: "loading-more", page });
    try {
      const next = await listIssuesRef.current({ ...query, cursor: page.endCursor });
      setList({
        status: "ready",
        page: {
          rows: [...page.rows, ...next.rows],
          hasNextPage: next.hasNextPage,
          ...(next.endCursor === undefined ? {} : { endCursor: next.endCursor }),
        },
      });
    } catch (error: unknown) {
      setList({ status: "error", message: failureMessage(error), page });
    }
  }

  async function openIssue(row: LinearIssueRow): Promise<void> {
    setDetail({ status: "loading", id: row.id });
    try {
      const loaded = await getIssueRef.current({ id: row.id });
      setDetail({ status: "ready", detail: loaded });
    } catch (error: unknown) {
      setDetail({ status: "error", message: failureMessage(error) });
    }
  }

  const page =
    list.status === "ready" || list.status === "loading-more"
      ? list.page
      : list.status === "error"
        ? list.page
        : undefined;
  const selectedId =
    detail.status === "ready"
      ? detail.detail.id
      : detail.status === "loading"
        ? detail.id
        : undefined;

  return (
    <section
      aria-label="Linear"
      className="linear-issues"
      data-narrow={props.isNarrow === true ? "true" : "false"}
    >
      <header className="code-board__header">
        <div className="code-board__identity">
          <h1 className="code-board__title">Linear</h1>
          <p className="code-board__subtitle">
            Read-only issues from the connected Linear workspace.
          </p>
        </div>
        <div className="linear-issues__actions">
          {props.onClose === undefined ? null : (
            <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
              Back to workspace
            </OctantButton>
          )}
        </div>
      </header>

      <div className="linear-issues__toolbar">
        <label className="linear-issues__search">
          <Search aria-hidden="true" size={14} strokeWidth={1.7} />
          <span className="sr-only">Search Linear issues</span>
          <OctantInput
            aria-label="Search Linear issues"
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search issues"
            type="search"
            value={search}
          />
          {search === "" ? null : (
            <OctantButton
              aria-label="Clear issue search"
              className="linear-issues__search-clear"
              onClick={() => setSearch("")}
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" size={14} strokeWidth={1.7} />
            </OctantButton>
          )}
        </label>
        <div className="linear-issues__filters">
          <FilterSelect
            ariaLabel="Team"
            onChange={setTeamId}
            options={filters?.teams}
            placeholder="Team"
            value={teamId}
          />
          <FilterSelect
            ariaLabel="State"
            onChange={setStateId}
            options={filters?.states}
            placeholder="State"
            value={stateId}
          />
          <FilterSelect
            ariaLabel="Assignee"
            onChange={setAssigneeId}
            options={filters?.assignees}
            placeholder="Assignee"
            value={assigneeId}
          />
          <FilterSelect
            ariaLabel="Project"
            onChange={setProjectId}
            options={filters?.projects}
            placeholder="Project"
            value={projectId}
          />
        </div>
      </div>

      {list.status === "loading" ? (
        <ShellState
          eyebrow="Linear"
          message="Reading issues from the connected workspace."
          state="neutral"
          title="Loading issues"
        />
      ) : null}

      {list.status === "error" && page === undefined ? (
        <ShellState
          action={{
            label: "Retry",
            onClick: () => {
              setList({ status: "loading" });
              void listIssuesRef.current(query).then(
                (next) => setList({ status: "ready", page: next }),
                (error: unknown) => setList({ status: "error", message: failureMessage(error) }),
              );
            },
          }}
          eyebrow="Linear"
          message={list.message}
          state="warning"
          title="Issues unavailable"
        />
      ) : null}

      {page === undefined ? null : (
        <div className="linear-issues__panes">
          <div className="linear-issues__list-pane">
            {page.rows.length === 0 ? (
              <OctantEmptyStateRoot role="status">
                <OctantEmptyStateCopy className="col-span-2">
                  <OctantEmptyStateTitle>
                    {debouncedSearch.trim() === "" && isEmptyFilter(query.filter)
                      ? "No issues in this workspace."
                      : "No issues match this search."}
                  </OctantEmptyStateTitle>
                </OctantEmptyStateCopy>
                {debouncedSearch.trim() === "" && isEmptyFilter(query.filter) ? null : (
                  <OctantEmptyStateActions className="col-span-2 col-start-1">
                    <OctantButton
                      onClick={() => {
                        setSearch("");
                        setTeamId(ALL);
                        setStateId(ALL);
                        setAssigneeId(ALL);
                        setProjectId(ALL);
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Clear filters
                    </OctantButton>
                  </OctantEmptyStateActions>
                )}
              </OctantEmptyStateRoot>
            ) : (
              <ul className="linear-issues__list">
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <OctantButton
                      aria-pressed={selectedId === row.id}
                      className="linear-issues__row"
                      onClick={() => void openIssue(row)}
                      type="button"
                    >
                      <CircleDot
                        aria-hidden="true"
                        className="linear-issues__icon"
                        size={16}
                        strokeWidth={1.7}
                      />
                      <div className="linear-issues__row-content">
                        <div className="linear-issues__title-line">
                          <span className="linear-issues__identifier">{row.identifier}</span>
                          <span className="linear-issues__title">{row.title}</span>
                        </div>
                        <div className="linear-issues__meta">
                          <OctantBadge variant="secondary">{row.state.name}</OctantBadge>
                          <span>{row.assignee ?? "Unassigned"}</span>
                        </div>
                      </div>
                    </OctantButton>
                  </li>
                ))}
              </ul>
            )}
            {list.status === "error" && page !== undefined ? (
              <p className="linear-issues__status" role="alert">
                {list.message}
              </p>
            ) : null}
            {page.hasNextPage ? (
              <OctantButton
                disabled={list.status === "loading-more"}
                onClick={() => void loadMore()}
                size="sm"
                type="button"
                variant="ghost"
              >
                {list.status === "loading-more" ? "Loading…" : "Load more"}
              </OctantButton>
            ) : null}
          </div>
          <div className="linear-issues__detail-pane">
            {detail.status === "idle" ? (
              <p className="linear-issues__status">Select an issue to read its description.</p>
            ) : null}
            {detail.status === "loading" ? (
              <ShellState
                eyebrow="Linear"
                message="Reading the selected issue."
                state="neutral"
                title="Loading issue"
              />
            ) : null}
            {detail.status === "error" ? (
              <ShellState
                eyebrow="Linear"
                message={detail.message}
                state="warning"
                title="Issue unavailable"
              />
            ) : null}
            {detail.status === "ready" ? <IssueDetail detail={detail.detail} /> : null}
          </div>
        </div>
      )}
    </section>
  );
}

function IssueDetail(props: { readonly detail: LinearIssueDetail }) {
  return (
    <article aria-label={props.detail.identifier} className="linear-issues__detail">
      <header className="linear-issues__detail-header">
        <p className="linear-issues__identifier">{props.detail.identifier}</p>
        <h2 className="linear-issues__detail-title">{props.detail.title}</h2>
        <div className="linear-issues__meta">
          <OctantBadge variant="secondary">{props.detail.state.name}</OctantBadge>
          <span>{props.detail.assignee ?? "Unassigned"}</span>
        </div>
        <a href={props.detail.url} rel="noreferrer" target="_blank">
          Open in Linear
        </a>
      </header>
      {props.detail.description === "" ? (
        <p className="linear-issues__status">No description.</p>
      ) : (
        <p className="linear-issues__description">{props.detail.description}</p>
      )}
      {props.detail.descriptionTruncated ? (
        <p className="linear-issues__status">Description truncated. Open in Linear for the rest.</p>
      ) : null}
    </article>
  );
}

function FilterSelect(props: {
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly value: string;
  readonly options: ReadonlyArray<LinearIssueFilterOption> | undefined;
  readonly onChange: (value: string) => void;
}) {
  return (
    <OctantSelectField
      aria-label={props.ariaLabel}
      onValueChange={props.onChange}
      options={[{ id: ALL, label: "All" }, ...(props.options ?? [])]}
      placeholder={props.placeholder}
      value={props.value}
    />
  );
}

function buildQuery(
  search: string,
  teamId: string,
  stateId: string,
  assigneeId: string,
  projectId: string,
): LinearIssueListInput {
  const trimmed = search.trim();
  const filter = {
    ...(teamId === ALL ? {} : { teamId }),
    ...(stateId === ALL ? {} : { stateId }),
    ...(assigneeId === ALL ? {} : { assigneeId }),
    ...(projectId === ALL ? {} : { projectId }),
  };
  return decodeLinearIssueListInput({
    ...(trimmed === "" ? {} : { search: trimmed }),
    ...(isEmptyFilter(filter) ? {} : { filter }),
  });
}

function isEmptyFilter(
  filter:
    | LinearIssueListFilter
    | {
        readonly teamId?: string;
        readonly stateId?: string;
        readonly assigneeId?: string;
        readonly projectId?: string;
      }
    | undefined,
): boolean {
  return (
    filter === undefined ||
    (filter.teamId === undefined &&
      filter.stateId === undefined &&
      filter.assigneeId === undefined &&
      filter.projectId === undefined)
  );
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Linear issue browse is unavailable.";
}
