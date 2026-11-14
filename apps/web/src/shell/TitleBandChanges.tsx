import { OctantButton } from "../ui/base/OctantButton";

/**
 * What a Project's checkout has changed since its last commit. The counts are
 * absent until a first reading lands, and `updating` marks a value that may
 * describe an earlier tree.
 */
export interface TitleBandChangesFacts {
  readonly insertions?: number;
  readonly deletions?: number;
  readonly updating: boolean;
  readonly onOpen: () => void;
}

/**
 * The checkout's uncommitted line changes, as one button into the changes view.
 *
 * It is always there while the window is on a Project with a Git checkout, "+0
 * −0" included, so the band never gains or loses a control as a reading
 * arrives: until the first one lands an em dash holds the same slot, and a
 * reading that has gone stale stays on screen in meta ink with "Updating…" as
 * its tooltip. A count is green or red only when it is above zero. It sits at
 * the leading end of the trailing cluster so a longer number grows leftward and
 * never moves a tool button under the pointer.
 */
export function TitleBandChanges(props: { readonly changes: TitleBandChangesFacts }) {
  const { insertions, deletions, updating } = props.changes;
  const known = insertions !== undefined && deletions !== undefined;
  const added = known ? insertions.toLocaleString("en") : undefined;
  const removed = known ? deletions.toLocaleString("en") : undefined;
  return (
    <OctantButton
      aria-label={
        known
          ? `Uncommitted changes: ${added ?? ""} lines added, ${removed ?? ""} removed`
          : "Uncommitted changes: not read"
      }
      className="window-chrome__changes"
      data-updating={updating || !known ? "true" : undefined}
      onClick={props.changes.onOpen}
      size="sm"
      title={updating ? "Updating…" : known ? "Review changes" : "No changes could be read"}
      type="button"
      variant="bare"
    >
      {known ? (
        <>
          <span
            aria-hidden="true"
            className="window-chrome__changes-added"
            data-zero={insertions === 0 ? "true" : undefined}
          >{`+${added ?? ""}`}</span>
          <span
            aria-hidden="true"
            className="window-chrome__changes-removed"
            data-zero={deletions === 0 ? "true" : undefined}
          >{`−${removed ?? ""}`}</span>
        </>
      ) : (
        <span aria-hidden="true" className="window-chrome__changes-none">
          —
        </span>
      )}
    </OctantButton>
  );
}
