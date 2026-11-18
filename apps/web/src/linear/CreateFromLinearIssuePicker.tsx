import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { LinearIssueContextRequest } from "@octant/contracts";
import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import {
  linearIssueBrowseAvailable,
  type LinearIssueListPage,
  type LinearIssueRow,
} from "@octant/contracts/linear-issues";
import { Check, Circle, CircleCheck, CircleDashed, CircleDot, Search } from "../ui/icons";
import { loadList, peekList } from "../composer/createFromCache";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { PopupSkeletonRows } from "../ui/base/PopupSkeletonRows";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { OctantAlert } from "../ui/base/OctantAlert";

export function useLinearIssuesCreateAvailable(
  client: IntegrationClient | undefined,
  pluginEnabled: boolean,
): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (client === undefined || !pluginEnabled) {
      setAvailable(false);
      return;
    }
    const readSnapshot = client.authenticationSnapshot;
    if (typeof readSnapshot !== "function") {
      setAvailable(false);
      return;
    }
    const pending = thenableFrom(readSnapshot.call(client));
    if (pending === undefined) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    void pending
      .then((snapshot) => {
        if (!cancelled) {
          setAvailable(
            linearIssueBrowseAvailable(
              (snapshot as IntegrationAuthenticationSnapshot).capabilities,
            ),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, pluginEnabled]);
  return available;
}

function thenableFrom(value: unknown): Promise<unknown> | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    return value as Promise<unknown>;
  }
  return undefined;
}

const LINEAR_ISSUES_KEY = "linear-issues";

/** The first page of issues, shared with whoever reads ahead of the popup opening. */
export function loadLinearIssues(client: IntegrationClient): Promise<LinearIssueListPage> {
  const listIssues = client.listIssues;
  if (typeof listIssues !== "function") {
    return Promise.reject(new Error("Linear issues are unavailable."));
  }
  return loadList(client, LINEAR_ISSUES_KEY, () => listIssues.call(client, {}));
}

function linearStateFrom(page: LinearIssueListPage): IssueListState {
  return {
    kind: "ready",
    rows: page.rows,
    hasNextPage: page.hasNextPage,
    ...(page.endCursor === undefined ? {} : { endCursor: page.endCursor }),
  };
}

export interface CreateFromLinearIssuePickerProps {
  readonly client: IntegrationClient;
  readonly selected?: LinearIssueContextRequest;
  readonly onSelect: (
    issue: LinearIssueContextRequest & { readonly identifier: string },
    title: string,
  ) => void;
  readonly disabled?: boolean;
}

type IssueListState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly rows: ReadonlyArray<LinearIssueRow>;
      readonly hasNextPage: boolean;
      readonly endCursor?: string;
    };

/**
 * Composer Linear tab for create-from-issue. Selecting a row attaches only the
 * opaque node id; the server re-reads and frames issue text.
 */
export function CreateFromLinearIssuePicker(props: CreateFromLinearIssuePickerProps) {
  const { client, onSelect } = props;
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [issues, setIssues] = useState<IssueListState>(() => {
    const cached = peekList<LinearIssueListPage>(client, LINEAR_ISSUES_KEY);
    return cached === undefined ? { kind: "loading" } : linearStateFrom(cached.value);
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const issuesGeneration = useRef(0);

  const loadIssues = useCallback(
    async (search: string) => {
      const listIssues = client.listIssues;
      if (typeof listIssues !== "function") {
        setIssues({ kind: "unavailable", message: "Linear issues are unavailable." });
        return;
      }
      const operation = ++issuesGeneration.current;
      // The first page with no search is read ahead and kept: it shows at once
      // and is asked again behind the rows when it has grown old.
      const kept = search === "";
      const cached = kept ? peekList<LinearIssueListPage>(client, LINEAR_ISSUES_KEY) : undefined;
      if (cached === undefined) setIssues({ kind: "loading" });
      else {
        setIssues(linearStateFrom(cached.value));
        if (cached.fresh) return;
      }
      try {
        const page: LinearIssueListPage = kept
          ? await loadLinearIssues(client)
          : await listIssues({ search, pageSize: 30 as never });
        if (operation !== issuesGeneration.current) return;
        setIssues(linearStateFrom(page));
      } catch (error) {
        if (operation !== issuesGeneration.current) return;
        if (cached !== undefined) return;
        setIssues({
          kind: "error",
          message: error instanceof Error ? error.message : "Linear issues are unavailable.",
        });
      }
    },
    [client],
  );

  useEffect(() => {
    void loadIssues(debouncedQuery.trim());
  }, [debouncedQuery, loadIssues]);

  const loadMore = async () => {
    if (issues.kind !== "ready" || issues.endCursor === undefined) return;
    const listIssues = client.listIssues;
    if (typeof listIssues !== "function") return;
    const operation = issuesGeneration.current;
    const search = debouncedQuery.trim();
    const cursor = issues.endCursor;
    setLoadingMore(true);
    try {
      const page = await listIssues({
        ...(search === "" ? {} : { search }),
        pageSize: 30 as never,
        cursor: cursor as never,
      });
      if (operation !== issuesGeneration.current) return;
      if (debouncedQuery.trim() !== search) return;
      setIssues((current) => {
        if (current.kind !== "ready" || current.endCursor !== cursor) return current;
        return {
          kind: "ready",
          rows: [...current.rows, ...page.rows],
          hasNextPage: page.hasNextPage,
          ...(page.endCursor === undefined ? {} : { endCursor: page.endCursor }),
        };
      });
    } catch (error) {
      if (operation !== issuesGeneration.current) return;
      setIssues({
        kind: "error",
        message: error instanceof Error ? error.message : "Linear issues are unavailable.",
      });
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="create-from-issue">
      <label className="octant-popover-search">
        <Search aria-hidden="true" size={14} />
        <OctantInput
          aria-label="Search Linear issues"
          disabled={props.disabled}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Linear issues…"
          type="search"
          unstyled
          value={query}
        />
      </label>
      {issues.kind === "loading" || issues.kind === "idle" ? (
        <PopupSkeletonRows label="Loading issues…" />
      ) : null}
      {issues.kind === "error" || issues.kind === "unavailable" ? (
        <OctantAlert tone="warning">{issues.message}</OctantAlert>
      ) : null}
      {issues.kind === "ready" ? (
        issues.rows.length === 0 ? (
          <p className="octant-popover-empty" role="status">
            {query.trim() === "" ? "No issues in this workspace." : "No issues match."}
          </p>
        ) : (
          <ul aria-label="Linear issues" className="create-from__list" id={listboxId}>
            {issues.rows.map((row) => {
              const selected = props.selected !== undefined && props.selected.id === row.id;
              const State = linearStateGlyph(row.state.type);
              return (
                <li key={row.id}>
                  <OctantButton
                    aria-label={`${row.identifier} ${row.title}`}
                    aria-pressed={selected}
                    className="octant-popover-option create-from__row"
                    disabled={props.disabled}
                    onClick={() => onSelect({ id: row.id, identifier: row.identifier }, row.title)}
                    title={row.title}
                    type="button"
                    variant="bare"
                  >
                    <State aria-hidden="true" className="create-from__state" size={14} />
                    <span className="create-from__copy">
                      <span className="create-from__title">{row.title}</span>
                      <span className="oct-menu-detail create-from__meta">
                        {row.identifier} · {row.state.name}
                        {row.assignee === undefined ? "" : ` · ${row.assignee}`}
                      </span>
                    </span>
                    {selected ? (
                      <Check
                        aria-hidden="true"
                        className="octant-popover-option__check"
                        size={14}
                      />
                    ) : null}
                  </OctantButton>
                </li>
              );
            })}
            {issues.hasNextPage ? (
              <li>
                <OctantButton
                  className="octant-popover-option create-from__more"
                  disabled={loadingMore || props.disabled}
                  onClick={() => void loadMore()}
                  type="button"
                  variant="bare"
                >
                  {loadingMore ? "Loading more…" : "Load more issues"}
                </OctantButton>
              </li>
            ) : null}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** Linear says what kind of state a team's own state name is; the glyph follows the kind. */
function linearStateGlyph(type: string) {
  switch (type) {
    case "completed":
      return CircleCheck;
    case "started":
      return CircleDot;
    case "backlog":
    case "triage":
      return CircleDashed;
    default:
      return Circle;
  }
}
