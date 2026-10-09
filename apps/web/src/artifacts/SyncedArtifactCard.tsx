import type { ArtifactLibrarySyncedEntry } from "@octant/contracts/artifact-library";
import { artifactEditedAgo } from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { KIND_LABEL } from "./ArtifactCard";
import { ArtifactSyncStatus } from "./ArtifactSyncStatus";

export interface SyncedArtifactCardProps {
  readonly entry: ArtifactLibrarySyncedEntry;
  readonly observedAt: string;
  /** Opens its versions, and the threads here it can be opened in. */
  readonly onSelect: (canvasId: ArtifactLibrarySyncedEntry["canvasId"]) => void;
  readonly onRestore: (canvasId: ArtifactLibrarySyncedEntry["canvasId"]) => void;
}

/**
 * An artifact another of this person's computers made, not open in a thread
 * here yet. It names the computer that wrote the version shown and the
 * Project it was filed under there, because neither is a Project or a
 * computer this one can open.
 */
export function SyncedArtifactCard(props: SyncedArtifactCardProps) {
  const { entry } = props;
  return (
    <li className="artifact-card">
      <OctantButton
        aria-label={`${entry.title}, from ${entry.computerName}`}
        className="artifact-card__button"
        onClick={() => props.onSelect(entry.canvasId)}
        type="button"
        variant="ghost"
      >
        <span className="artifact-card__preview" aria-hidden="true">
          {entry.preview === undefined ? (
            <span className="artifact-card__preview-fallback">{KIND_LABEL[entry.kind]}</span>
          ) : (
            // The host's own drawing; the contract refuses script before it travels.
            <span
              className="artifact-card__preview-svg"
              dangerouslySetInnerHTML={{ __html: entry.preview.markup }}
            />
          )}
        </span>
        <span className="artifact-card__body">
          <span className="artifact-card__title">{entry.title}</span>
          <span className="artifact-card__meta">
            {entry.projectName} · {KIND_LABEL[entry.kind]}
          </span>
          <span className="artifact-card__meta">
            {entry.status === "deleted" ? "Last written on" : "Written on"} {entry.computerName}
          </span>
          <span className="artifact-card__footer">
            <span>Synced</span>
            <span className="artifact-card__edited">
              {artifactEditedAgo(String(entry.updatedAt), props.observedAt)}
            </span>
          </span>
        </span>
      </OctantButton>
      <ArtifactSyncStatus
        status={entry.status}
        {...(entry.deletedOn === undefined ? {} : { deletedOn: entry.deletedOn })}
        onChoose={() => props.onSelect(entry.canvasId)}
        onRestore={() => props.onRestore(entry.canvasId)}
        title={entry.title}
      />
    </li>
  );
}
