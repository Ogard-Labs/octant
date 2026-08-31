import type {
  ArtifactKind,
  ArtifactLibraryEntry,
  ArtifactLibraryListing,
  ArtifactLibraryTab,
} from "@octant/contracts/artifact-library";
import type { OctantMode, ProjectId } from "@octant/contracts";
import { Plus, Search } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantEmptyState } from "../ui/base/OctantEmptyState";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTabs, OctantTabsList, OctantTabsTab } from "../ui/base/OctantTabs";
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
  const hasActiveFilters =
    filters.query.trim() !== "" ||
    filters.kind !== undefined ||
    filters.projectId !== undefined ||
    filters.mode !== undefined;
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
          <Search aria-hidden="true" size={14} strokeWidth={1.8} />
          <label className="sr-only" htmlFor="artifact-library-search">
            Search artifacts
          </label>
          <OctantInput
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
        <OctantSelectField
          className="artifact-library__select select"
          id="artifact-library-kind"
          onValueChange={(value) =>
            value === "" ? clear("kind") : change({ kind: value as ArtifactKind })
          }
          options={[
            { id: "", label: "Any kind" },
            ...KINDS.map((kind) => ({
              id: kind,
              label: `${kind[0]?.toUpperCase()}${kind.slice(1)}`,
            })),
          ]}
          value={filters.kind ?? ""}
        />

        <label className="sr-only" htmlFor="artifact-library-project">
          Filter by Project
        </label>
        <OctantSelectField
          className="artifact-library__select select"
          id="artifact-library-project"
          onValueChange={(value) =>
            value === "" ? clear("projectId") : change({ projectId: value as ProjectId })
          }
          options={[
            { id: "", label: "Any Project" },
            ...(listing?.projects ?? []).map((project) => ({
              id: String(project.projectId),
              label: `${project.name} (${String(project.artifactCount)})`,
            })),
          ]}
          value={filters.projectId === undefined ? "" : String(filters.projectId)}
        />

        <label className="sr-only" htmlFor="artifact-library-mode">
          Filter by mode
        </label>
        <OctantSelectField
          className="artifact-library__select select"
          id="artifact-library-mode"
          onValueChange={(value) =>
            value === "" ? clear("mode") : change({ mode: value as OctantMode })
          }
          options={[
            { id: "", label: "Any mode" },
            ...MODES.map((mode) => ({
              id: mode,
              label: `${mode[0]?.toUpperCase()}${mode.slice(1)}`,
            })),
          ]}
          value={filters.mode ?? ""}
        />
      </div>

      <OctantTabs
        onValueChange={(value) => {
          if (TABS.some((tab) => tab.id === value)) {
            change({ tab: value as ArtifactLibraryTab });
          }
        }}
        value={filters.tab}
      >
        <OctantTabsList aria-label="Artifact groups" className="artifact-library__tabs tabs">
          {TABS.map((tab) => (
            <OctantTabsTab className="artifact-library__tab tab" key={tab.id} value={tab.id}>
              {tab.label}
            </OctantTabsTab>
          ))}
        </OctantTabsList>
      </OctantTabs>

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
        <OctantEmptyState
          {...(filters.tab === "shared" || hasActiveFilters
            ? {
                action: (
                  <OctantButton
                    onClick={() => props.onFiltersChange({ tab: "all", query: "" })}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {filters.tab === "shared" ? "View all artifacts" : "Clear filters"}
                  </OctantButton>
                ),
              }
            : {})}
          className="artifact-library__empty"
          message={
            filters.tab === "shared"
              ? "Artifacts you share will appear here."
              : hasActiveFilters
                ? "Clear or adjust the active filters to see other artifacts."
                : "Create an artifact from a thread to see it here."
          }
          role="status"
          title={
            filters.tab === "shared"
              ? "Nothing is shared right now."
              : hasActiveFilters
                ? "No artifacts match these filters"
                : "No artifacts yet"
          }
        />
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
