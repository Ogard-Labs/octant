import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { LinearIssueContextRequest } from "@octant/contracts";
import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import {
  linearIssueBrowseAvailable,
  type LinearIssueListPage,
  type LinearIssueRow,
} from "@octant/contracts/linear-issues";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { useDebouncedValue } from "../lib/useDebouncedValue";

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

export interface CreateFromLinearIssuePickerProps {
  readonly client: IntegrationClient;
  readonly selected?: LinearIssueContextRequest;
  readonly onSelect: (issue: LinearIssueContextRequest & { readonly identifier: string }) => void;
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
  const [issues, setIssues] = useState<IssueListState>({ kind: "loading" });
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
      setIssues({ kind: "loading" });
      try {
        const page: LinearIssueListPage = await listIssues(
          search === "" ? {} : { search, pageSize: 30 as never },
        );
        if (operation !== issuesGeneration.current) return;
        setIssues({
          kind: "ready",
          rows: page.rows,
          hasNextPage: page.hasNextPage,
          ...(page.endCursor === undefined ? {} : { endCursor: page.endCursor }),
        });
      } catch (error) {
        if (operation !== issuesGeneration.current) return;
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
      <OctantInput
        aria-label="Search Linear issues"
        disabled={props.disabled}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search Linear issues…"
        type="search"
        value={query}
      />
      {issues.kind === "loading" ? <p role="status">Loading issues…</p> : null}
      {issues.kind === "error" || issues.kind === "unavailable" ? (
        <p role="alert">{issues.message}</p>
      ) : null}
      {issues.kind === "ready" ? (
        issues.rows.length === 0 ? (
          <p role="status">No issues match.</p>
        ) : (
          <ul aria-label="Linear issues" className="github-picker__listbox" id={listboxId}>
            {issues.rows.map((row) => {
              const selected = props.selected !== undefined && props.selected.id === row.id;
              return (
                <li key={row.id}>
                  <OctantButton
                    aria-pressed={selected}
                    className="github-picker__option"
                    disabled={props.disabled}
                    onClick={() => onSelect({ id: row.id, identifier: row.identifier })}
                    type="button"
                    variant="ghost"
                  >
                    <span className="github-picker__option-name">
                      {row.identifier} {row.title}
                    </span>
                    <span className="github-picker__option-meta">
                      {row.state.name}
                      {row.assignee === undefined ? "" : ` · ${row.assignee}`}
                    </span>
                  </OctantButton>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {issues.kind === "ready" && issues.hasNextPage ? (
        <OctantButton
          disabled={loadingMore || props.disabled}
          onClick={() => void loadMore()}
          size="sm"
          type="button"
          variant="secondary"
        >
          {loadingMore ? "Loading more…" : "Load more issues"}
        </OctantButton>
      ) : null}
    </div>
  );
}
