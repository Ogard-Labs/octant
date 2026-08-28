import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  GithubAuthenticationSnapshot,
  GithubIssueContextRequest,
  GithubIssueRow,
  GithubRepositoryRow,
} from "@octant/contracts";
import { GitHubRepositoryPicker } from "../code/GitHubRepositoryPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export function issuesReadIsAvailable(snapshot: GithubAuthenticationSnapshot): boolean {
  return (
    snapshot !== null &&
    typeof snapshot === "object" &&
    Array.isArray(snapshot.capabilities) &&
    snapshot.capabilities.some(
      (capability) => capability.kind === "issues-read" && capability.available,
    )
  );
}

export function useGithubIssuesCreateAvailable(
  client: GithubClient | undefined,
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
        if (!cancelled)
          setAvailable(issuesReadIsAvailable(snapshot as GithubAuthenticationSnapshot));
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

export interface CreateFromIssuePickerProps {
  readonly client: GithubClient;
  readonly selected?: GithubIssueContextRequest;
  readonly onSelect: (issue: GithubIssueContextRequest) => void;
  readonly disabled?: boolean;
}

type IssueListState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly rows: ReadonlyArray<GithubIssueRow>;
      readonly hasNextPage: boolean;
      readonly endCursor?: string;
    };

export function CreateFromIssuePicker(props: CreateFromIssuePickerProps) {
  const { client, onSelect } = props;
  const listboxId = useId();
  const [repository, setRepository] = useState<GithubRepositoryRow>();
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<IssueListState>({ kind: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  const issuesGeneration = useRef(0);

  const loadIssues = useCallback(
    async (owner: string, name: string, search: string) => {
      const readCatalogue = client.readCatalogue;
      if (typeof readCatalogue !== "function") {
        setIssues({ kind: "unavailable", message: "GitHub issues are unavailable." });
        return;
      }
      const operation = ++issuesGeneration.current;
      setIssues({ kind: "loading" });
      try {
        const response = await readCatalogue({
          kind: "issues",
          owner,
          name,
          pageSize: 30 as never,
          ...(search === "" ? {} : { search }),
        });
        if (operation !== issuesGeneration.current) return;
        if (response.kind === "unavailable") {
          setIssues({
            kind: "unavailable",
            message: response.remediation ?? "GitHub issues are unavailable.",
          });
          return;
        }
        if (response.kind !== "issues") {
          setIssues({ kind: "error", message: "GitHub returned an unexpected response." });
          return;
        }
        setIssues({
          kind: "ready",
          rows: response.page.rows,
          hasNextPage: response.page.hasNextPage,
          ...(response.page.endCursor === undefined ? {} : { endCursor: response.page.endCursor }),
        });
      } catch (error) {
        if (operation !== issuesGeneration.current) return;
        setIssues({
          kind: "error",
          message: error instanceof Error ? error.message : "GitHub issues are unavailable.",
        });
      }
    },
    [client],
  );

  useEffect(() => {
    if (repository === undefined) {
      setIssues({ kind: "idle" });
      return;
    }
    void loadIssues(repository.owner, repository.name, query.trim());
  }, [loadIssues, query, repository]);

  const loadMore = async () => {
    if (repository === undefined || issues.kind !== "ready" || issues.endCursor === undefined) {
      return;
    }
    const readCatalogue = client.readCatalogue;
    if (typeof readCatalogue !== "function") return;
    const operation = issuesGeneration.current;
    const owner = repository.owner;
    const name = repository.name;
    const search = query.trim();
    const cursor = issues.endCursor;
    setLoadingMore(true);
    try {
      const response = await readCatalogue({
        kind: "issues",
        owner,
        name,
        pageSize: 30 as never,
        cursor: cursor as never,
        ...(search === "" ? {} : { search }),
      });
      if (operation !== issuesGeneration.current) return;
      if (repository.owner !== owner || repository.name !== name || query.trim() !== search) {
        return;
      }
      if (response.kind !== "issues") return;
      setIssues((current) => {
        if (current.kind !== "ready" || current.endCursor !== cursor) return current;
        return {
          kind: "ready",
          rows: [...current.rows, ...response.page.rows],
          hasNextPage: response.page.hasNextPage,
          ...(response.page.endCursor === undefined ? {} : { endCursor: response.page.endCursor }),
        };
      });
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="create-from-issue">
      <GitHubRepositoryPicker
        client={client}
        onSelect={setRepository}
        {...(repository === undefined ? {} : { selectedNodeId: repository.nodeId })}
      />
      {repository === undefined ? (
        <p className="create-from-issue__hint">Choose a repository to list its issues.</p>
      ) : (
        <>
          <OctantInput
            aria-label="Search issues"
            disabled={props.disabled}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search issues…"
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
              <ul aria-label="GitHub issues" className="github-picker__listbox" id={listboxId}>
                {issues.rows.map((row) => {
                  const selected =
                    props.selected !== undefined &&
                    props.selected.owner === repository.owner &&
                    props.selected.name === repository.name &&
                    props.selected.number === row.number;
                  return (
                    <li key={row.number}>
                      <OctantButton
                        aria-pressed={selected}
                        className="github-picker__option"
                        disabled={props.disabled}
                        onClick={() =>
                          onSelect({
                            owner: repository.owner,
                            name: repository.name,
                            number: row.number,
                          })
                        }
                        type="button"
                        variant="ghost"
                      >
                        <span className="github-picker__option-name">
                          #{row.number} {row.title}
                        </span>
                        <span className="github-picker__option-meta">
                          {row.state} · {row.author}
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
        </>
      )}
    </div>
  );
}
