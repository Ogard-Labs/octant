import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronLeft, CircleCheck, CircleDot, Search } from "lucide-react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  GithubAuthenticationSnapshot,
  GithubIssueContextRequest,
  GithubIssueRow,
  GithubRepositoryRow,
} from "@octant/contracts";
import { describeGithubRemediation } from "./githubRemediation";
import { GitHubRepositoryPicker } from "../code/GitHubRepositoryPicker";
import { loadList, peekList } from "../composer/createFromCache";
import { PopupSkeletonRows } from "../ui/base/PopupSkeletonRows";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantAlert } from "../ui/base/OctantAlert";

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

type IssuesResponse = Awaited<ReturnType<GithubClient["readCatalogue"]>>;

const ISSUE_PAGE_SIZE = 30;

const issuesKey = (owner: string, name: string) => `github-issues:${owner}/${name}`;

/** A repository's first page of issues, shared with whoever reads ahead of the person choosing it. */
export function loadGithubIssues(
  client: GithubClient,
  owner: string,
  name: string,
): Promise<IssuesResponse> {
  return loadList(
    client,
    issuesKey(owner, name),
    () => client.readCatalogue({ kind: "issues", owner, name, pageSize: ISSUE_PAGE_SIZE as never }),
    { keep: (response) => response.kind === "issues" },
  );
}

function issueListStateFrom(response: IssuesResponse): IssueListState {
  if (response.kind === "unavailable") {
    return {
      kind: "unavailable",
      message:
        response.remediation === undefined
          ? "GitHub issues are unavailable."
          : describeGithubRemediation(response.remediation),
    };
  }
  if (response.kind !== "issues") {
    return { kind: "error", message: "GitHub returned an unexpected response." };
  }
  return {
    kind: "ready",
    rows: response.page.rows,
    hasNextPage: response.page.hasNextPage,
    ...(response.page.endCursor === undefined ? {} : { endCursor: response.page.endCursor }),
  };
}

export interface CreateFromIssuePickerProps {
  readonly client: GithubClient;
  readonly selected?: GithubIssueContextRequest;
  readonly onSelect: (issue: GithubIssueContextRequest, title: string) => void;
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
      // A repository's first page, with no search, is read ahead and kept: it
      // shows at once and is asked again behind the rows when it has grown old.
      const kept = search === "";
      const cached = kept ? peekList<IssuesResponse>(client, issuesKey(owner, name)) : undefined;
      if (cached === undefined) setIssues({ kind: "loading" });
      else {
        setIssues(issueListStateFrom(cached.value));
        if (cached.fresh) return;
      }
      try {
        const response = kept
          ? await loadGithubIssues(client, owner, name)
          : await readCatalogue({
              kind: "issues",
              owner,
              name,
              pageSize: ISSUE_PAGE_SIZE as never,
              search,
            });
        if (operation !== issuesGeneration.current) return;
        setIssues(issueListStateFrom(response));
      } catch (error) {
        if (operation !== issuesGeneration.current) return;
        if (cached !== undefined) return;
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
      {repository === undefined ? (
        <GitHubRepositoryPicker
          client={client}
          onPreview={(row) =>
            void loadGithubIssues(client, row.owner, row.name).catch(() => undefined)
          }
          onSelect={setRepository}
        />
      ) : (
        <>
          {/* The chosen repository folds to one row, so the issues get the room
              instead of opening under a list nobody is choosing from any more. */}
          <div className="create-from-issue__repository">
            <OctantButton
              aria-label="Change repository"
              onClick={() => {
                setRepository(undefined);
                setQuery("");
              }}
              size="sm"
              title="Change repository"
              type="button"
              variant="ghost"
            >
              <ChevronLeft aria-hidden="true" size={14} />
              <span className="oct-menu-option">
                {repository.owner}/{repository.name}
              </span>
            </OctantButton>
          </div>
          <label className="octant-popover-search">
            <Search aria-hidden="true" size={14} />
            <OctantInput
              aria-label="Search issues"
              disabled={props.disabled}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search issues…"
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
                {query.trim() === "" ? "No issues in this repository." : "No issues match."}
              </p>
            ) : (
              <ul aria-label="GitHub issues" className="create-from__list" id={listboxId}>
                {issues.rows.map((row) => {
                  const selected =
                    props.selected !== undefined &&
                    props.selected.owner === repository.owner &&
                    props.selected.name === repository.name &&
                    props.selected.number === row.number;
                  const State = row.state === "open" ? CircleDot : CircleCheck;
                  return (
                    <li key={row.number}>
                      <OctantButton
                        aria-label={`#${String(row.number)} ${row.title}`}
                        aria-pressed={selected}
                        className="octant-popover-option create-from__row"
                        disabled={props.disabled}
                        onClick={() =>
                          onSelect(
                            {
                              owner: repository.owner,
                              name: repository.name,
                              number: row.number,
                            },
                            row.title,
                          )
                        }
                        title={row.title}
                        type="button"
                        variant="bare"
                      >
                        <State
                          aria-hidden="true"
                          className="create-from__state"
                          data-state={row.state}
                          size={14}
                        />
                        <span className="create-from__copy">
                          <span className="create-from__title">{row.title}</span>
                          <span className="oct-menu-detail create-from__meta">
                            #{row.number} · {repository.owner}/{repository.name} · {row.author}
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
        </>
      )}
    </div>
  );
}
