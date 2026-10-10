import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import { artifactEditedAgo } from "@octant/domain";
import { Link2, Lock } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { ArtifactSyncStatus } from "./ArtifactSyncStatus";

export interface ArtifactCardProps {
  readonly entry: ArtifactLibraryEntry;
  readonly observedAt: string;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
  readonly onExport?: (entry: ArtifactLibraryEntry) => void;
  /**
   * Shows which computer wrote each version, and resolves what sync left:
   * two versions to choose between, or a deletion to restore. Absent on a
   * host without artifact sync.
   */
  readonly onSync?: (canvasId: ArtifactLibraryEntry["canvasId"]) => void;
  readonly onRestore?: (canvasId: ArtifactLibraryEntry["canvasId"]) => void;
}

export const KIND_LABEL: Record<ArtifactLibraryEntry["kind"], string> = {
  document: "Document",
  diagram: "Diagram",
  chart: "Chart",
  table: "Table",
  code: "Code",
  mixed: "Mixed",
};

/**
 * One artifact in the gallery.
 *
 * The preview is drawn by the host and arrives as markup, so the card injects
 * it rather than re-deriving a picture the mirror would draw differently. It is
 * a static SVG the contract already refused script in, and it is decorative:
 * the accessible name is the artifact's own title.
 */
export function ArtifactCard(props: ArtifactCardProps) {
  const { entry } = props;
  return (
    <li className="artifact-card">
      <OctantButton
        className="artifact-card__button"
        onClick={() => props.onOpen(entry)}
        type="button"
        variant="ghost"
      >
        <span className="artifact-card__preview" aria-hidden="true">
          {entry.preview === undefined ? (
            <span className="artifact-card__preview-fallback">{KIND_LABEL[entry.kind]}</span>
          ) : (
            // The markup is the host's own drawing, and the contract refuses
            // script and external references before it can be carried at all.
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
          {entry.writtenOn === undefined ? null : (
            <span className="artifact-card__meta">Written on {entry.writtenOn}</span>
          )}
          <span className="artifact-card__footer">
            <span className="artifact-card__share">
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
            <span className="artifact-card__edited">
              {artifactEditedAgo(String(entry.updatedAt), props.observedAt)}
            </span>
          </span>
        </span>
      </OctantButton>
      <ArtifactSyncStatus
        {...(entry.syncStatus === undefined ? {} : { status: entry.syncStatus })}
        {...(entry.deletedOn === undefined ? {} : { deletedOn: entry.deletedOn })}
        onChoose={props.onSync === undefined ? undefined : () => props.onSync?.(entry.canvasId)}
        onRestore={
          props.onRestore === undefined ? undefined : () => props.onRestore?.(entry.canvasId)
        }
        title={entry.title}
      />
      {props.onExport === undefined &&
      (props.onSync === undefined || entry.writtenOn === undefined) ? null : (
        <span className="artifact-card__actions">
          {props.onExport === undefined ? null : (
            <OctantButton
              className="artifact-card__export"
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
              className="artifact-card__export"
              onClick={() => props.onSync?.(entry.canvasId)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Versions…
            </OctantButton>
          )}
        </span>
      )}
    </li>
  );
}
