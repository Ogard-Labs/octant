import type { ArtifactSyncStatus as SyncStatus } from "@octant/contracts/artifact-library";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";

export interface ArtifactSyncStatusProps {
  readonly status?: SyncStatus;
  readonly deletedOn?: string;
  /** The artifact's title, so each action names what it acts on. */
  readonly title: string;
  readonly onChoose: (() => void) | undefined;
  readonly onRestore: (() => void) | undefined;
}

/**
 * What sync has left to resolve for one artifact, under its card.
 *
 * The badge carries the state in words, not colour: "Two versions" until the
 * person keeps one or merges them, and "Deleted on <computer>" while a
 * deletion elsewhere is all that is left. Nothing is shown when it is current.
 */
export function ArtifactSyncStatus(props: ArtifactSyncStatusProps) {
  if (props.status === undefined || props.status === "current") return null;
  if (props.status === "two-versions") {
    return (
      <span className="artifact-card__sync">
        <OctantBadge variant="secondary">Two versions</OctantBadge>
        {props.onChoose === undefined ? null : (
          <OctantButton
            aria-label={`Choose between the two versions of ${props.title}`}
            onClick={props.onChoose}
            size="sm"
            type="button"
            variant="secondary"
          >
            Choose…
          </OctantButton>
        )}
      </span>
    );
  }
  return (
    <span className="artifact-card__sync">
      <OctantBadge variant="secondary">
        {props.deletedOn === undefined ? "Deleted elsewhere" : `Deleted on ${props.deletedOn}`}
      </OctantBadge>
      {props.onRestore === undefined ? null : (
        <OctantButton
          aria-label={`Restore ${props.title}`}
          onClick={props.onRestore}
          size="sm"
          type="button"
          variant="secondary"
        >
          Restore
        </OctantButton>
      )}
    </span>
  );
}
