import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  GithubCatalogueFreshness,
  GithubCatalogueUnavailable,
  GithubRepositoryRow,
  GithubRepositoryVisibility,
} from "@octant/contracts";
import { Check, Link, RefreshCw, Search } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { OctantInput } from "../ui/base/OctantInput";
import { describeGithubRemediation } from "../github/githubRemediation";
import { parseGithubRepositoryReference } from "./githubRepositoryReference";
import { OctantAlert } from "../ui/base/OctantAlert";

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
  "insecure-storage":
    "Open Settings → GitHub, remove the insecure credential, then set up GitHub again.",
  "external-token": "An ambient GitHub token blocks this capability.",
  "invalid-cursor": "The repository page reference expired. Refresh the list.",
  unavailable: "GitHub repositories are unavailable on this host.",
};

function describeUnavailable(state: {
  readonly reason: GithubCatalogueUnavailable["reason"];
  readonly remediation?: string | undefined;
}): string {
  return state.remediation === undefined
    ? UNAVAILABLE_FALLBACKS[state.reason]
    : describeGithubRemediation(state.remediation);
}

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
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const generation = useRef(0);
  const linkGeneration = useRef(0);

  // One field takes a search or a pasted repository. A reference is not a
  // search term: nothing in the catalogue would match "owner/name" typed whole.
  const reference = parseGithubRepositoryReference(query);
  const trimmedQuery = reference === undefined ? query.trim() : "";

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
    return () => {
      linkGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    const readCatalogue = client.readCatalogue;
    if (typeof readCatalogue !== "function") return;
    const pending = readCatalogue({ kind: "recent-repositories" });
    if (pending === null || typeof pending !== "object" || typeof pending.then !== "function") {
      return;
    }
    let alive = true;
    void pending
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
    linkGeneration.current += 1;
    setLinkBusy(false);
    setLinkError(undefined);
    onSelect(row);
    // Recording the recent selection is a convenience write; its failure
    // never blocks the selection itself.
    void client
      .recordRecentRepository({ kind: "record-recent-repository", nodeId: row.nodeId })
      .catch(() => undefined);
  };

  /**
   * Resolve a repository the person typed or pasted. A public repository the
   * viewer does not own is still a legitimate Project; the server reads it
   * live and answers with the same normalized row the catalogue serves, which
   * then rides the ordinary confirm-and-clone flow.
   */
  const resolveLink = async (event: React.FormEvent) => {
    event.preventDefault();
    if (reference === undefined) return;
    const operation = ++linkGeneration.current;
    setLinkBusy(true);
    setLinkError(undefined);
    try {
      const response = await client.readCatalogue({ kind: "repository", ...reference });
      if (operation !== linkGeneration.current) return;
      if (response.kind === "unavailable") {
        setLinkError(describeUnavailable(response));
        return;
      }
      if (response.kind !== "repository") {
        setLinkError("GitHub returned an unexpected response.");
        return;
      }
      if (response.freshness.status === "stale") {
        setLinkError(
          STALE_REASON_LABELS[response.freshness.staleReason ?? ""] ??
            "The repository facts may be stale. Refresh and try again.",
        );
        return;
      }
      setQuery("");
      select(response.row);
    } catch (error) {
      if (operation !== linkGeneration.current) return;
      setLinkError(error instanceof Error ? error.message : "GitHub repositories are unavailable.");
    } finally {
      if (operation === linkGeneration.current) setLinkBusy(false);
    }
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
      <form
        className="github-picker__form"
        noValidate
        onSubmit={(event) => void resolveLink(event)}
      >
        <div className="github-picker__toolbar">
          <label className="octant-popover-search github-picker__search">
            <Search aria-hidden="true" size={14} />
            <OctantInput
              aria-label="Search GitHub repositories"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(undefined);
                setLinkError(undefined);
                // A repository still resolving was asked for by the old text.
                linkGeneration.current += 1;
                setLinkBusy(false);
              }}
              placeholder="Search, or paste a GitHub link…"
              type="search"
              unstyled
              value={query}
            />
          </label>
          <OctantTooltip label="Refresh repositories">
            <OctantButton
              aria-label="Refresh repositories"
              onClick={() => void loadPage(trimmedQuery, { refresh: true })}
              size="icon"
              type="button"
              variant="ghost"
            >
              <RefreshCw aria-hidden="true" size={14} />
            </OctantButton>
          </OctantTooltip>
        </div>
        {reference === undefined ? null : (
          <OctantButton
            className="octant-popover-option"
            disabled={linkBusy}
            type="submit"
            variant="bare"
          >
            <Link aria-hidden="true" size={14} />
            {linkBusy ? "Resolving…" : `Use ${reference.owner}/${reference.name}`}
          </OctantButton>
        )}
      </form>
      {linkError === undefined ? null : (
        <OctantAlert className="github-picker__note" tone="warning">
          {linkError}
        </OctantAlert>
      )}
      {catalogue.kind === "loading" ? (
        <p className="octant-popover-empty" role="status">
          Loading repositories…
        </p>
      ) : null}

      {catalogue.kind === "error" ? (
        <>
          <OctantAlert tone="warning">{catalogue.message}</OctantAlert>
          <OctantButton
            onClick={() => void loadPage(trimmedQuery)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Retry
          </OctantButton>
        </>
      ) : null}

      {catalogue.kind === "unavailable" ? (
        <>
          <OctantAlert tone="warning">{describeUnavailable(catalogue)}</OctantAlert>
          <OctantButton
            onClick={() => void loadPage(trimmedQuery)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Retry
          </OctantButton>
        </>
      ) : null}

      {catalogue.kind === "ready" && reference === undefined ? (
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
            <p className="octant-popover-empty" role="status">
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
                <li aria-hidden="true" className="octant-popover-group">
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
              size="sm"
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
            size="sm"
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
                    <dd>{describeGithubRemediation(capability.remediation ?? "")}</dd>
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
        <li aria-hidden="true" className="octant-popover-group">
          All repositories
        </li>
      ) : null}
      <li
        aria-selected={props.selected}
        className={
          props.active
            ? "octant-popover-option github-picker__option github-picker__option--active"
            : "octant-popover-option github-picker__option"
        }
        id={props.id}
        onClick={props.onClick}
        role="option"
      >
        <span className="github-picker__option-name">
          {row.owner}/{row.name}
        </span>
        {/* Only what tells two rows apart. The branch and permission were the
            same words on every row; they stay under Repository details. */}
        {row.visibility === "public" ? null : (
          <span className="github-picker__option-meta">
            <span>{GITHUB_VISIBILITY_LABELS[row.visibility]}</span>
          </span>
        )}
        {props.selected ? (
          <Check aria-hidden="true" className="octant-popover-option__check" size={14} />
        ) : null}
      </li>
    </>
  );
}
