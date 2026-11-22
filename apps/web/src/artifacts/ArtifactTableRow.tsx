import { useId } from "react";
import { artifactEditedAgo } from "@octant/domain";
import { Link2, Lock } from "../ui/icons";
import { OctantButton } from "../ui/base/OctantButton";
import { ArtifactSyncStatus } from "./ArtifactSyncStatus";
import { KIND_LABEL } from "./ArtifactCard";
import { ArtifactTags } from "./ArtifactTags";
import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";

export interface ArtifactTableRowProps {
  readonly entry: ArtifactLibraryEntry;
  readonly observedAt: string;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
  readonly onExport?: (entry: ArtifactLibraryEntry) => void;
  readonly onSync?: (canvasId: ArtifactLibraryEntry["canvasId"]) => void;
  readonly onRestore?: (canvasId: ArtifactLibraryEntry["canvasId"]) => void;
  readonly onTagAdd?: (canvasId: ArtifactLibraryEntry["canvasId"], tag: string) => void;
  readonly onTagRemove?: (canvasId: ArtifactLibraryEntry["canvasId"], tag: string) => void;
}

/** The column names, drawn once over each list; every row says the same in its own words. */
export function ArtifactTableHead() {
  return (
    <div aria-hidden="true" className="artifact-table__head">
      <span>Name</span>
      <span>Tags</span>
      <span>Shared</span>
      <span>Edited</span>
      <span />
    </div>
  );
}

/**
 * One artifact as a row of the library's List view. The open button is the
 * name column alone: the tags, the sync state and the export controls are real
 * buttons of their own, and a button cannot hold a button, so they sit beside
 * it in the row's grid and the open button's description carries the facts.
 */
export function ArtifactTableRow(props: ArtifactTableRowProps) {
  const { entry } = props;
  const rowId = useId();
  const edited = artifactEditedAgo(String(entry.updatedAt), props.observedAt);
  return (
    <li className="artifact-table-row">
      <OctantButton
        // Named for the artifact alone; where it lives, whether it is shared
        // and when it changed are its description.
        aria-describedby={`${rowId}-meta ${rowId}-share ${rowId}-edited`}
        aria-label={entry.title}
        className="artifact-table-row__open"
        onClick={() => props.onOpen(entry)}
        type="button"
        variant="bare"
      >
        <span className="artifact-table-row__title">{entry.title}</span>
        <span className="artifact-table-row__meta" id={`${rowId}-meta`}>
          {entry.projectName ?? "No Project"} · {KIND_LABEL[entry.kind]}
        </span>
      </OctantButton>
      {/* Always drawn, so a row with no tags and no tag editing keeps its
          cells under their heads instead of sliding one column left. */}
      <span className="artifact-table-row__tags">
        <ArtifactTags
          tags={entry.tags ?? []}
          variant="row"
          {...(props.onTagAdd === undefined
            ? {}
            : { onAdd: (tag) => props.onTagAdd?.(entry.canvasId, tag) })}
          {...(props.onTagRemove === undefined
            ? {}
            : { onRemove: (tag) => props.onTagRemove?.(entry.canvasId, tag) })}
        />
      </span>
      <span className="artifact-table-row__share" id={`${rowId}-share`}>
        {entry.shared ? (
          <>
            <Link2 aria-hidden="true" size={12} />
            Shared
          </>
        ) : (
          <>
            <Lock aria-hidden="true" size={12} />
            Private
          </>
        )}
      </span>
      <span className="artifact-table-row__edited" id={`${rowId}-edited`}>
        {/* The column head already says Edited, so the cell drops the word
            for the eye; a screen reader, which hears the cell as the row's
            description, keeps the whole sentence. */}
        <span aria-hidden="true">{editedCell(edited)}</span>
        <span className="sr-only">{edited}</span>
      </span>
      <span className="artifact-table-row__aside">
        <ArtifactSyncStatus
          {...(entry.syncStatus === undefined ? {} : { status: entry.syncStatus })}
          {...(entry.deletedOn === undefined ? {} : { deletedOn: entry.deletedOn })}
          onChoose={props.onSync === undefined ? undefined : () => props.onSync?.(entry.canvasId)}
          onRestore={
            props.onRestore === undefined ? undefined : () => props.onRestore?.(entry.canvasId)
          }
          title={entry.title}
        />
        {props.onExport === undefined ? null : (
          <OctantButton
            className="artifact-table-row__action"
            onClick={() => props.onExport?.(entry)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Export…
          </OctantButton>
        )}
        {props.onSync === undefined || entry.writtenOn === undefined ? null : (
          <OctantButton
            aria-label={`Versions of ${entry.title}`}
            className="artifact-table-row__action"
            onClick={() => props.onSync?.(entry.canvasId)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Versions…
          </OctantButton>
        )}
      </span>
    </li>
  );
}

/** "Edited 3 hours ago" as the Edited column's cell: "3 hours ago". */
function editedCell(sentence: string): string {
  const rest = sentence.replace(/^Edited /, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
