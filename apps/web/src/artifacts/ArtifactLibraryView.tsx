import type {
  ArtifactKind,
  ArtifactLibraryEntry,
  ArtifactLibraryListing,
  ArtifactLibraryTab,
} from "@octant/contracts/artifact-library";
import type { OctantMode, ProjectId } from "@octant/contracts";
import { Plus, Search } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { ArtifactCard } from "./ArtifactCard";
import type { ArtifactLibraryFilters } from "./useArtifactLibrary";

export interface ArtifactLibraryViewProps {
  readonly listing: ArtifactLibraryListing | undefined;
  readonly filters: ArtifactLibraryFilters;
  readonly busy: boolean;
  readonly message?: string;
  readonly observedAt: string;
  readonly onFiltersChange: (next: ArtifactLibraryFilters) => void;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
  /**
   * Starts a thread to make an artifact in. Absent on a host that cannot start
   * one, which hides the action rather than offering a dead gesture.
   */
  readonly onCreate?: () => void;
}

const TABS: ReadonlyArray<{ readonly id: ArtifactLibraryTab; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "by-project", label: "By Project" },
  { id: "shared", label: "Shared" },
];

const KINDS: ReadonlyArray<ArtifactKind> = [
  "document",
  "diagram",
  "chart",
  "table",
  "code",
  "mixed",
];
const MODES: ReadonlyArray<OctantMode> = ["chat", "work", "code"];

/**
 * Everything this host has made, in one place.
 *
 * The page is deliberately a gallery rather than a list: an artifact is a thing
 * you recognise by looking at it, and a person coming back to one they made
 * last month remembers its shape long before its title. Grouping by Project is
 * a tab rather than the default, because the question "what have I made" is
 * asked more often than "what is in this Project" — which the Project's own
 * page already answers.
 */
export function ArtifactLibraryView(props: ArtifactLibraryViewProps) {
  const { filters, listing } = props;
  const entries = listing?.entries ?? [];
  const change = (next: Partial<ArtifactLibraryFilters>) =>
    props.onFiltersChange({ ...filters, ...next });
  // Clearing a filter removes the key rather than setting it to undefined:
  // `exactOptionalPropertyTypes` treats those as different, and the query the
  // host decodes has no room for an explicitly absent field.
  const clear = (key: "kind" | "projectId" | "mode") => {
    const { [key]: _removed, ...rest } = filters;
    props.onFiltersChange(rest);
  };

  return (
    <section aria-label="Artifact library" className="artifact-library">
      <header className="artifact-library__header">
        <h1 className="artifact-library__title">Artifacts</h1>
        {props.onCreate === undefined ? null : (
          <OctantButton
            onClick={props.onCreate}
            size="sm"
            title="Artifacts are made in a thread. This starts one."
            type="button"
            variant="secondary"
          >
            <Plus aria-hidden="true" size={12} strokeWidth={1.8} />
            New artifact
          </OctantButton>
        )}
      </header>

      <div className="artifact-library__controls">
        <div className="artifact-library__search">
          <Search aria-hidden="true" size={13} strokeWidth={1.8} />
          <label className="sr-only" htmlFor="artifact-library-search">
            Search artifacts
          </label>
          <input
            className="artifact-library__search-input"
            id="artifact-library-search"
            onChange={(event) => change({ query: event.target.value })}
            placeholder="Search artifacts"
            type="search"
            value={filters.query}
          />
        </div>

        <label className="sr-only" htmlFor="artifact-library-kind">
          Filter by kind
        </label>
        <select
          className="artifact-library__select"
          id="artifact-library-kind"
          onChange={(event) =>
            event.target.value === ""
              ? clear("kind")
              : change({ kind: event.target.value as ArtifactKind })
          }
          value={filters.kind ?? ""}
        >
          <option value="">Any kind</option>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind[0]?.toUpperCase()}
              {kind.slice(1)}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="artifact-library-project">
          Filter by Project
        </label>
        <select
          className="artifact-library__select"
          id="artifact-library-project"
          onChange={(event) =>
            event.target.value === ""
              ? clear("projectId")
              : change({ projectId: event.target.value as ProjectId })
          }
          value={filters.projectId === undefined ? "" : String(filters.projectId)}
        >
          <option value="">Any Project</option>
          {(listing?.projects ?? []).map((project) => (
            <option key={String(project.projectId)} value={String(project.projectId)}>
              {project.name} ({String(project.artifactCount)})
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="artifact-library-mode">
          Filter by mode
        </label>
        <select
          className="artifact-library__select"
          id="artifact-library-mode"
          onChange={(event) =>
            event.target.value === ""
              ? clear("mode")
              : change({ mode: event.target.value as OctantMode })
          }
          value={filters.mode ?? ""}
        >
          <option value="">Any mode</option>
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode[0]?.toUpperCase()}
              {mode.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div aria-label="Artifact groups" className="artifact-library__tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            aria-selected={filters.tab === tab.id}
            className="artifact-library__tab"
            key={tab.id}
            onClick={() => change({ tab: tab.id })}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {props.message === undefined ? null : (
        <p className="artifact-library__message" role="status">
          {props.message}
        </p>
      )}

      {filters.tab === "by-project" ? (
        <ArtifactsByProject entries={entries} observedAt={props.observedAt} onOpen={props.onOpen} />
      ) : (
        <ul className="artifact-library__grid">
          {entries.map((entry) => (
            <ArtifactCard
              entry={entry}
              key={String(entry.canvasId)}
              observedAt={props.observedAt}
              onOpen={props.onOpen}
            />
          ))}
        </ul>
      )}

      {props.busy || entries.length > 0 ? null : (
        <p className="artifact-library__empty" role="status">
          {filters.tab === "shared"
            ? "Nothing is shared right now."
            : "No artifacts match what you are looking for."}
        </p>
      )}

      {listing?.truncated === true ? (
        <p className="artifact-library__truncated" role="status">
          Showing {String(entries.length)} of {String(listing.matchCount)}. Narrow the search to see
          the rest.
        </p>
      ) : null}
    </section>
  );
}

function ArtifactsByProject(props: {
  readonly entries: ReadonlyArray<ArtifactLibraryEntry>;
  readonly observedAt: string;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
}) {
  const grouped = new Map<string, ArtifactLibraryEntry[]>();
  for (const entry of props.entries) {
    const bucket = grouped.get(entry.projectName) ?? [];
    bucket.push(entry);
    grouped.set(entry.projectName, bucket);
  }
  return (
    <div className="artifact-library__groups">
      {[...grouped.entries()]
        .sort((left, right) => left[0].localeCompare(right[0], "en-US"))
        .map(([projectName, entries]) => (
          <section aria-label={projectName} className="artifact-library__group" key={projectName}>
            <h2 className="artifact-library__group-title">{projectName}</h2>
            <ul className="artifact-library__grid">
              {entries.map((entry) => (
                <ArtifactCard
                  entry={entry}
                  key={String(entry.canvasId)}
                  observedAt={props.observedAt}
                  onOpen={props.onOpen}
                />
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
