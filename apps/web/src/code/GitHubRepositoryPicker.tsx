import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  GithubCatalogueFreshness,
  GithubCatalogueUnavailable,
  GithubRepositoryRow,
  GithubRepositoryVisibility,
} from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

/**
 * The searchable, paginated, keyboard-operable GitHub
 * repository picker for the Code composer. It renders only rows the
 * server-authoritative catalogue returned: opaque cursors drive pagination,
 * stale pages stay visible but labeled, and every unavailable capability is
 * an honest state with its remediation. Scope details stay behind an
 * explicit disclosure so rows remain compact.
 */

export interface GitHubRepositoryPickerProps {
  readonly client: GithubClient;
  readonly onSelect: (repository: GithubRepositoryRow) => void;
  readonly selectedNodeId?: string;
  readonly pageSize?: number;
}

type CatalogueState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "unavailable";
      readonly reason: GithubCatalogueUnavailable["reason"];
      readonly remediation?: string;
    }
  | {
      readonly kind: "ready";
      readonly rows: ReadonlyArray<GithubRepositoryRow>;
      readonly hasNextPage: boolean;
      readonly endCursor?: string;
      readonly freshness: GithubCatalogueFreshness;
    };

export const GITHUB_VISIBILITY_LABELS: Readonly<Record<GithubRepositoryVisibility, string>> = {
  public: "Public",
  private: "Private",
  internal: "Internal",
};

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
  "invalid-cursor": "The repository page reference expired. Refresh the list.",
  unavailable: "GitHub repositories are unavailable on this host.",
};

const DEFAULT_PAGE_SIZE = 30;

export function GitHubRepositoryPicker(props: GitHubRepositoryPickerProps) {
  const { client, onSelect, selectedNodeId } = props;
  const pageSize = props.pageSize ?? DEFAULT_PAGE_SIZE;
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<ReadonlyArray<GithubRepositoryRow>>([]);
  const [catalogue, setCatalogue] = useState<CatalogueState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const generation = useRef(0);

  const trimmedQuery = query.trim();

  const loadPage = useCallback(
    async (search: string, options: { readonly refresh?: boolean } = {}) => {
      const operation = ++generation.current;
      setCatalogue({ kind: "loading" });
      try {
        const response = await client.readCatalogue({
          kind: "repositories",
          pageSize: pageSize as never,
          ...(search === "" ? {} : { search }),
          ...(options.refresh === true ? { refresh: true } : {}),
        });
        if (operation !== generation.current) return;
        if (response.kind === "unavailable") {
          setCatalogue({
            kind: "unavailable",
            reason: response.reason,
            ...(response.remediation === undefined ? {} : { remediation: response.remediation }),
          });
          return;
        }
        if (response.kind !== "repositories") {
          setCatalogue({ kind: "error", message: "GitHub returned an unexpected response." });
          return;
        }
        setCatalogue({
          kind: "ready",
          rows: response.page.rows,
          hasNextPage: response.page.hasNextPage,
          ...(response.page.endCursor === undefined ? {} : { endCursor: response.page.endCursor }),
          freshness: response.page.freshness,
        });
      } catch (error) {
        if (operation !== generation.current) return;
        setCatalogue({
          kind: "error",
          message: error instanceof Error ? error.message : "GitHub repositories are unavailable.",
        });
      }
    },
    [client, pageSize],
  );

  useEffect(() => {
    void loadPage(trimmedQuery);
  }, [loadPage, trimmedQuery]);

  useEffect(() => {
    let alive = true;
    void client
      .readCatalogue({ kind: "recent-repositories" })
      .then((response) => {
        if (!alive || response.kind !== "recent-repositories") return;
        setRecents(response.rows);
      })
      // Recents are a convenience; their failure never blocks the picker.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client]);

  const loadMore = async () => {
    if (catalogue.kind !== "ready" || catalogue.endCursor === undefined) return;
    const operation = generation.current;
    setLoadingMore(true);
    try {
      const response = await client.readCatalogue({
        kind: "repositories",
        pageSize: pageSize as never,
        cursor: catalogue.endCursor as never,
        ...(trimmedQuery === "" ? {} : { search: trimmedQuery }),
      });
      if (operation !== generation.current) return;
      if (response.kind !== "repositories") return;
      setCatalogue((current) => {
        if (current.kind !== "ready") return current;
        return {
          kind: "ready",
          rows: [...current.rows, ...response.page.rows],
          hasNextPage: response.page.hasNextPage,
          ...(response.page.endCursor === undefined ? {} : { endCursor: response.page.endCursor }),
          freshness: response.page.freshness,
        };
      });
    } catch {
      // The already-loaded rows remain valid; the user can retry Load more.
    } finally {
      setLoadingMore(false);
    }
  };

  const showRecents = trimmedQuery === "" && recents.length > 0;
  const options: ReadonlyArray<GithubRepositoryRow> = useMemo(() => {
    const rows = catalogue.kind === "ready" ? catalogue.rows : [];
    if (!showRecents) return rows;
    const recentIds = new Set(recents.map((row) => row.nodeId));
    return [...recents, ...rows.filter((row) => !recentIds.has(row.nodeId))];
  }, [catalogue, recents, showRecents]);

  const selectedRow = options.find((row) => row.nodeId === selectedNodeId);

  const optionId = (row: GithubRepositoryRow) => `${listboxId}-option-${row.nodeId}`;

  const select = (row: GithubRepositoryRow) => {
    onSelect(row);
    // Recording the recent selection is a convenience write; its failure
    // never blocks the selection itself.
    void client
      .recordRecentRepository({ kind: "record-recent-repository", nodeId: row.nodeId })
      .catch(() => undefined);
  };

  const handleListboxKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (options.length === 0) return;
    const lastIndex = options.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index === undefined ? 0 : Math.min(index + 1, lastIndex)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index === undefined ? lastIndex : Math.max(index - 1, 0)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(lastIndex);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const active = activeIndex === undefined ? undefined : options[activeIndex];
      if (active !== undefined) select(active);
    }
  };

  const activeOption =
    activeIndex === undefined || activeIndex >= options.length ? undefined : options[activeIndex];

  return (
    <div className="github-picker">
      <div className="github-picker__toolbar">
        <OctantInput
          aria-label="Search GitHub repositories"
          className="github-picker__search"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(undefined);
          }}
          placeholder="Search repositories…"
          type="search"
          value={query}
        />
        <OctantButton
          onClick={() => void loadPage(trimmedQuery, { refresh: true })}
          type="button"
          variant="secondary"
        >
          Refresh repositories
        </OctantButton>
      </div>

      {catalogue.kind === "loading" ? <p role="status">Loading repositories…</p> : null}

      {catalogue.kind === "error" ? (
        <>
          <p role="alert">{catalogue.message}</p>
          <OctantButton
            onClick={() => void loadPage(trimmedQuery)}
            type="button"
            variant="secondary"
          >
            Retry
          </OctantButton>
        </>
      ) : null}

      {catalogue.kind === "unavailable" ? (
        <>
          <p role="alert">{catalogue.remediation ?? UNAVAILABLE_FALLBACKS[catalogue.reason]}</p>
          <OctantButton
            onClick={() => void loadPage(trimmedQuery)}
            type="button"
            variant="secondary"
          >
            Retry
          </OctantButton>
        </>
      ) : null}

      {catalogue.kind === "ready" ? (
        <>
          {catalogue.freshness.status === "stale" ? (
            <p className="github-picker__note" role="status">
              Results may be stale —{" "}
              {STALE_REASON_LABELS[catalogue.freshness.staleReason ?? ""] ??
                "the catalogue could not be refreshed."}{" "}
              Refresh to retry.
            </p>
          ) : null}
          {options.length === 0 ? (
            <p className="github-picker__note" role="status">
              No repositories match.
            </p>
          ) : (
            <ul
              aria-activedescendant={
                activeOption === undefined ? undefined : optionId(activeOption)
              }
              aria-label="GitHub repositories"
              className="github-picker__listbox"
              onKeyDown={handleListboxKeyDown}
              role="listbox"
              tabIndex={0}
            >
              {showRecents ? (
                <li aria-hidden="true" className="github-picker__group-label">
                  Recent
                </li>
              ) : null}
              {options.map((row, index) => {
                const isRecentBoundary = showRecents && index === recents.length;
                return (
                  <RepositoryOption
                    active={activeIndex === index}
                    id={optionId(row)}
                    key={row.nodeId}
                    onClick={() => select(row)}
                    row={row}
                    selected={row.nodeId === selectedNodeId}
                    showAllLabel={isRecentBoundary}
                  />
                );
              })}
            </ul>
          )}
          {catalogue.hasNextPage ? (
            <OctantButton
              disabled={loadingMore}
              onClick={() => void loadMore()}
              type="button"
              variant="secondary"
            >
              {loadingMore ? "Loading more…" : "Load more repositories"}
            </OctantButton>
          ) : null}
        </>
      ) : null}

      {selectedRow === undefined ? null : (
        <div className="github-picker__details">
          <OctantButton
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
            type="button"
            variant="ghost"
          >
            Repository details
          </OctantButton>
          {detailsOpen ? (
            <dl className="github-picker__facts">
              <dt>Repository</dt>
              <dd>
                {selectedRow.owner}/{selectedRow.name}
              </dd>
              <dt>Visibility</dt>
              <dd>{GITHUB_VISIBILITY_LABELS[selectedRow.visibility]}</dd>
              <dt>Default branch</dt>
              <dd>{selectedRow.defaultBranch ?? "Unknown"}</dd>
              <dt>Your permission</dt>
              <dd>{selectedRow.viewerPermission}</dd>
              {selectedRow.capabilities
                .filter((capability) => capability.remediation !== undefined)
                .map((capability) => (
                  <div className="github-picker__capability" key={capability.kind}>
                    <dt>Access note</dt>
                    <dd>{capability.remediation}</dd>
                  </div>
                ))}
            </dl>
          ) : null}
        </div>
      )}
    </div>
  );
}

function RepositoryOption(props: {
  readonly row: GithubRepositoryRow;
  readonly id: string;
  readonly active: boolean;
  readonly selected: boolean;
  readonly showAllLabel: boolean;
  readonly onClick: () => void;
}) {
  const { row } = props;
  return (
    <>
      {props.showAllLabel ? (
        <li aria-hidden="true" className="github-picker__group-label">
          All repositories
        </li>
      ) : null}
      <li
        aria-selected={props.selected}
        className={
          props.active
            ? "github-picker__option github-picker__option--active"
            : "github-picker__option"
        }
        id={props.id}
        onClick={props.onClick}
        role="option"
      >
        <span className="github-picker__option-name">
          {row.owner}/{row.name}
        </span>
        <span className="github-picker__option-meta">
          <span>{GITHUB_VISIBILITY_LABELS[row.visibility]}</span>
          {row.defaultBranch === undefined ? null : <span>{row.defaultBranch}</span>}
          <span>{row.viewerPermission}</span>
        </span>
      </li>
    </>
  );
}
