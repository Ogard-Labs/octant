import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import { artifactEditedAgo } from "@octant/domain";
import { Link2, Lock } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { ArtifactSyncStatus } from "./ArtifactSyncStatus";
import { KIND_LABEL } from "./ArtifactCard";
import { ArtifactTags } from "./ArtifactTags";

export interface ArtifactListRowProps {
  readonly entry: ArtifactLibraryEntry;
  readonly observedAt: string;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
  readonly onExport?: (entry: ArtifactLibraryEntry) => void;
  readonly onSync?: (canvasId: ArtifactLibraryEntry["canvasId"]) => void;
  readonly onRestore?: (canvasId: ArtifactLibraryEntry["canvasId"]) => void;
  readonly onTagAdd?: (canvasId: ArtifactLibraryEntry["canvasId"], tag: string) => void;
  readonly onTagRemove?: (canvasId: ArtifactLibraryEntry["canvasId"], tag: string) => void;
}

/**
 * One artifact as a compact row: the list answer to the gallery card, for the
 * person who reads titles and facts rather than recognizing a picture. It
 * carries exactly what a card carries, because it opens the same artifact.
 */
export function ArtifactListRow(props: ArtifactListRowProps) {
  const { entry } = props;
  return (
    <li className="artifact-row">
      <OctantButton
        className="artifact-row__open"
        onClick={() => props.onOpen(entry)}
        type="button"
        variant="bare"
      >
        <span className="artifact-row__title">{entry.title}</span>
        <span className="artifact-row__meta">
          {entry.projectName ?? "No Project"} · {KIND_LABEL[entry.kind]}
        </span>
        <span className="artifact-row__facts">
          <span className="artifact-row__share">
            {entry.shared ? (
              <>
                <Link2 aria-hidden="true" size={12} strokeWidth={1.8} />
                Shared
              </>
            ) : (
              <>
                <Lock aria-hidden="true" size={12} strokeWidth={1.8} />
                Private
              </>
            )}
          </span>
          <span className="artifact-row__edited">
            {artifactEditedAgo(String(entry.updatedAt), props.observedAt)}
          </span>
        </span>
      </OctantButton>
      {/*
        Beside the open control, not inside it: a tag chip carries its own
        remove button, and a button cannot hold a button.
      */}
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
      <span className="artifact-row__aside">
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
            className="artifact-row__export"
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
            className="artifact-row__export"
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
