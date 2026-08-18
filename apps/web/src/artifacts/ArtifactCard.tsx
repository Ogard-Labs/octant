import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import { artifactEditedAgo } from "@octant/domain";
import { Link2, Lock } from "lucide-react";

export interface ArtifactCardProps {
  readonly entry: ArtifactLibraryEntry;
  readonly observedAt: string;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
}

const KIND_LABEL: Record<ArtifactLibraryEntry["kind"], string> = {
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
      <button className="artifact-card__button" onClick={() => props.onOpen(entry)} type="button">
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
          <span className="artifact-card__footer">
            <span className="artifact-card__share">
              {entry.shared ? (
                <>
                  <Link2 aria-hidden="true" size={11} strokeWidth={1.8} />
                  Shared
                </>
              ) : (
                <>
                  <Lock aria-hidden="true" size={11} strokeWidth={1.8} />
                  Private
                </>
              )}
            </span>
            <span className="artifact-card__edited">
              {artifactEditedAgo(String(entry.updatedAt), props.observedAt)}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
