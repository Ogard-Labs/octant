import type {
  ArtifactKind,
  ArtifactLibraryEntry,
  ArtifactLibraryListing,
  ArtifactLibraryTab,
} from "@octant/contracts/artifact-library";
import type { CanvasId, OctantMode, ProjectId } from "@octant/contracts";
import { Layers, LayoutGrid, List, Plus, Search } from "lucide-react";
import { SurfaceEmpty, SurfaceHeader, SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTabs, OctantTabsList, OctantTabsTab } from "../ui/base/OctantTabs";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactListRow } from "./ArtifactListRow";
import { SyncedArtifactCard } from "./SyncedArtifactCard";
import type { ArtifactLibraryFilters } from "./useArtifactLibrary";
import type { ArtifactLibraryView as LibraryViewMode } from "./artifactLibraryViewPreference";

export interface ArtifactLibraryViewProps {
  readonly listing: ArtifactLibraryListing | undefined;
  readonly filters: ArtifactLibraryFilters;
  readonly busy: boolean;
  readonly message?: string;
  readonly observedAt: string;
  /** Gallery cards or compact rows; the window remembers its own choice. */
  readonly view: LibraryViewMode;
  readonly onViewChange: (view: LibraryViewMode) => void;
  readonly onFiltersChange: (next: ArtifactLibraryFilters) => void;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
  readonly onExport?: (entry: ArtifactLibraryEntry) => void;
  /**
   * Starts a thread to make an artifact in. Absent on a host that cannot start
   * one, which hides the action rather than offering a dead gesture.
   */
  readonly onCreate?: () => void;
  /** Leaves the library for the workspace; absent when it is not a route. */
  readonly onClose?: () => void;
  /**
   * Opens an artifact's synced versions: which computer wrote each, two
   * versions to choose between, or the threads it can be opened in here.
   * Absent on a host without artifact sync.
   */
  readonly onSync?: (canvasId: CanvasId) => void;
  /** Restores an artifact whose deletion on another computer is all that is left. */
  readonly onRestore?: (canvasId: CanvasId) => void;
  /** Adds one of the person's own tags; absent when this surface cannot change them. */
  readonly onTagAdd?: (canvasId: CanvasId, tag: string) => void;
  /** Removes one of the person's own tags; absent when this surface cannot change them. */
  readonly onTagRemove?: (canvasId: CanvasId, tag: string) => void;
}

const TABS: ReadonlyArray<{ readonly id: ArtifactLibraryTab; readonly label: string }> = [
  { id: "by-project", label: "By Project" },
  { id: "all", label: "All" },
  { id: "by-tag", label: "By tag" },
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

/** A Canvas a Chat thread owns outside every Project files under this label. */
const NO_PROJECT = "No Project";
/** In the By tag arrangement, an artifact that carries no tag files under this. */
const NO_TAG = "No tags";

/**
 * Everything this host has made, in one place.
 *
 * The page opens grouped by Project, because that is how a person comes back
 * to their work; the flat All tab remains one click away. A gallery card is
 * how an artifact is recognized, and the list row is how its facts are read —
 * the person chooses, and the window remembers. Tags are the person's own
 * filing on top: they group and filter without moving an artifact anywhere.
 */
export function ArtifactLibraryView(props: ArtifactLibraryViewProps) {
  const { filters, listing } = props;
  const entries = listing?.entries ?? [];
  const synced = listing?.synced ?? [];
  const syncActions = {
    ...(props.onSync === undefined ? {} : { onSync: props.onSync }),
    ...(props.onRestore === undefined ? {} : { onRestore: props.onRestore }),
  };
  const tagActions = {
    ...(props.onTagAdd === undefined ? {} : { onTagAdd: props.onTagAdd }),
    ...(props.onTagRemove === undefined ? {} : { onTagRemove: props.onTagRemove }),
  };
  const hasActiveFilters =
    filters.query.trim() !== "" ||
    filters.kind !== undefined ||
    filters.projectId !== undefined ||
    filters.mode !== undefined ||
    filters.tag !== undefined;
  const change = (next: Partial<ArtifactLibraryFilters>) =>
    props.onFiltersChange({ ...filters, ...next });
  // Clearing a filter removes the key rather than setting it to undefined:
  // `exactOptionalPropertyTypes` treats those as different, and the query the
  // host decodes has no room for an explicitly absent field.
  const clear = (key: "kind" | "projectId" | "mode" | "tag") => {
    const { [key]: _removed, ...rest } = filters;
    props.onFiltersChange(rest);
  };

  return (
    <div className="artifact-library">
      <SurfaceHeader
        subtitle="What your threads have made, across every Project."
        title="Artifacts"
        {...(props.onClose === undefined ? {} : { onBack: props.onClose })}
        {...(props.onCreate === undefined
          ? {}
          : {
              actions: (
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
              ),
            })}
      />

      <div className="surface-toolbar">
        <div className="surface-toolbar__search artifact-library__search">
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
            unstyled
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

        {(listing?.tags ?? []).length === 0 ? null : (
          <>
            <label className="sr-only" htmlFor="artifact-library-tag">
              Filter by tag
            </label>
            <OctantSelectField
              className="artifact-library__select select"
              id="artifact-library-tag"
              onValueChange={(value) => (value === "" ? clear("tag") : change({ tag: value }))}
              options={[
                { id: "", label: "Any tag" },
                ...(listing?.tags ?? []).map((tag) => ({
                  id: tag.name,
                  label: `${tag.name} (${String(tag.artifactCount)})`,
                })),
              ]}
              value={filters.tag ?? ""}
            />
          </>
        )}

        <OctantToggleGroup<LibraryViewMode>
          aria-label="Artifact view"
          className="artifact-library__view"
          onValueChange={(value) => {
            const next = value[0];
            if (next === "gallery" || next === "list") props.onViewChange(next);
          }}
          value={[props.view]}
        >
          <OctantToggleGroupItem aria-label="Gallery view" value="gallery">
            <LayoutGrid aria-hidden="true" size={14} strokeWidth={1.8} />
          </OctantToggleGroupItem>
          <OctantToggleGroupItem aria-label="List view" value="list">
            <List aria-hidden="true" size={14} strokeWidth={1.8} />
          </OctantToggleGroupItem>
        </OctantToggleGroup>
      </div>

      <OctantTabs
        onValueChange={(value) => {
          if (TABS.some((tab) => tab.id === value)) {
            change({ tab: value as ArtifactLibraryTab });
          }
        }}
        value={filters.tab}
      >
        <OctantTabsList aria-label="Artifact groups" className="surface-tabs">
          {TABS.map((tab) => (
            <OctantTabsTab key={tab.id} value={tab.id}>
              {tab.label}
            </OctantTabsTab>
          ))}
        </OctantTabsList>
      </OctantTabs>

      {props.message === undefined ? null : (
        <p className="oct-row-detail" role="status">
          {props.message}
        </p>
      )}

      {filters.tab === "by-project" ? (
        <GroupedArtifacts
          entries={entries}
          groupOf={(entry) => entry.projectName ?? NO_PROJECT}
          observedAt={props.observedAt}
          onOpen={props.onOpen}
          view={props.view}
          {...(props.onExport === undefined ? {} : { onExport: props.onExport })}
          {...syncActions}
          {...tagActions}
        />
      ) : filters.tab === "by-tag" ? (
        <ArtifactsByTag
          entries={entries}
          observedAt={props.observedAt}
          onOpen={props.onOpen}
          view={props.view}
          {...(props.onExport === undefined ? {} : { onExport: props.onExport })}
          {...syncActions}
          {...tagActions}
        />
      ) : (
        <ArtifactEntries
          className="artifact-library__grid"
          entries={entries}
          observedAt={props.observedAt}
          onOpen={props.onOpen}
          view={props.view}
          {...(props.onExport === undefined ? {} : { onExport: props.onExport })}
          {...syncActions}
          {...tagActions}
        />
      )}

      {synced.length === 0 || props.onSync === undefined || props.onRestore === undefined ? null : (
        <SurfaceSection label="From your other computers">
          <ul className="artifact-library__grid artifact-library__grid--grouped">
            {synced.map((entry) => (
              <SyncedArtifactCard
                entry={entry}
                key={String(entry.canvasId)}
                observedAt={props.observedAt}
                onRestore={props.onRestore ?? (() => undefined)}
                onSelect={props.onSync ?? (() => undefined)}
              />
            ))}
          </ul>
        </SurfaceSection>
      )}

      {props.busy || entries.length > 0 || synced.length > 0 ? null : (
        <SurfaceEmpty
          {...(filters.tab === "shared" || hasActiveFilters
            ? {
                action: (
                  <OctantButton
                    onClick={() => props.onFiltersChange({ tab: "all", query: "" })}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {filters.tab === "shared" ? "View all artifacts" : "Clear filters"}
                  </OctantButton>
                ),
              }
            : {})}
          icon={<Layers size={20} strokeWidth={1.5} />}
          detail={
            filters.tab === "shared"
              ? "Artifacts you share will appear here."
              : hasActiveFilters
                ? "Clear or adjust the active filters to see other artifacts."
                : "Create an artifact from a thread to see it here."
          }
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
        <p className="oct-meta" role="status">
          Showing {String(entries.length)} of {String(listing.matchCount)}. Narrow the search to see
          the rest.
        </p>
      ) : null}
    </div>
  );
}

interface EntryActions {
  readonly observedAt: string;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
  readonly onExport?: (entry: ArtifactLibraryEntry) => void;
  readonly onSync?: (canvasId: CanvasId) => void;
  readonly onRestore?: (canvasId: CanvasId) => void;
  readonly onTagAdd?: (canvasId: CanvasId, tag: string) => void;
  readonly onTagRemove?: (canvasId: CanvasId, tag: string) => void;
}

/** The same entries as gallery cards or as list rows, per the person's choice. */
function ArtifactEntries(
  props: EntryActions & {
    readonly className: string;
    readonly entries: ReadonlyArray<ArtifactLibraryEntry>;
    readonly view: LibraryViewMode;
  },
) {
  const { className, entries, view, ...actions } = props;
  if (view === "list") {
    return (
      <ul className="artifact-library__list">
        {entries.map((entry) => (
          <ArtifactListRow entry={entry} key={String(entry.canvasId)} {...actions} />
        ))}
      </ul>
    );
  }
  return (
    <ul className={className}>
      {entries.map((entry) => (
        <ArtifactCard entry={entry} key={String(entry.canvasId)} {...actions} />
      ))}
    </ul>
  );
}

/** One section per named group, alphabetical, each artifact once. */
function GroupedArtifacts(
  props: EntryActions & {
    readonly entries: ReadonlyArray<ArtifactLibraryEntry>;
    readonly groupOf: (entry: ArtifactLibraryEntry) => string;
    readonly view: LibraryViewMode;
  },
) {
  const grouped = new Map<string, ArtifactLibraryEntry[]>();
  for (const entry of props.entries) {
    const key = props.groupOf(entry);
    const bucket = grouped.get(key) ?? [];
    bucket.push(entry);
    grouped.set(key, bucket);
  }
  const { entries: _entries, groupOf: _groupOf, view, ...actions } = props;
  return (
    <div className="artifact-library__groups">
      {[...grouped.entries()]
        .sort((left, right) => left[0].localeCompare(right[0], "en-US"))
        .map(([label, groupEntries]) => (
          <SurfaceSection key={label} label={label}>
            <ArtifactEntries
              className="artifact-library__grid artifact-library__grid--grouped"
              entries={groupEntries}
              view={view}
              {...actions}
            />
          </SurfaceSection>
        ))}
    </div>
  );
}

/**
 * One section per tag — the person's virtual folders. An artifact with several
 * tags appears in each of them, because a folder view that hid the other
 * filing would deny the point of tags; what carries none gathers at the end.
 */
function ArtifactsByTag(
  props: EntryActions & {
    readonly entries: ReadonlyArray<ArtifactLibraryEntry>;
    readonly view: LibraryViewMode;
  },
) {
  const { entries, view, ...actions } = props;
  const sections = new Map<string, ArtifactLibraryEntry[]>();
  const untagged: ArtifactLibraryEntry[] = [];
  for (const entry of entries) {
    const tags = entry.tags ?? [];
    if (tags.length === 0) {
      untagged.push(entry);
      continue;
    }
    for (const tag of tags) {
      const bucket = sections.get(tag) ?? [];
      bucket.push(entry);
      sections.set(tag, bucket);
    }
  }
  return (
    <div className="artifact-library__groups">
      {[...sections.entries()]
        .sort((left, right) => left[0].localeCompare(right[0], "en-US"))
        .map(([label, sectionEntries]) => (
          <SurfaceSection key={label} label={label}>
            <ArtifactEntries
              className="artifact-library__grid artifact-library__grid--grouped"
              entries={sectionEntries}
              view={view}
              {...actions}
            />
          </SurfaceSection>
        ))}
      {untagged.length === 0 ? null : (
        <SurfaceSection label={NO_TAG}>
          <ArtifactEntries
            className="artifact-library__grid artifact-library__grid--grouped"
            entries={untagged}
            view={view}
            {...actions}
          />
        </SurfaceSection>
      )}
    </div>
  );
}
