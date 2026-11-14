import { OctantButton } from "../ui/base/OctantButton";

/** What a Code thread's checkout has changed since its last commit. */
export interface TitleBandChangesFacts {
  readonly insertions: number;
  readonly deletions: number;
  readonly onOpen: () => void;
}

/**
 * The open Code thread's uncommitted line changes, as one button into the
 * changes view.
 *
 * The size of the diff was only visible under the composer or in a panel the
 * reader had to open. In the title band it stays in view while the person
 * reads the transcript, and it sits at the leading end of the trailing cluster
 * so a longer number grows leftward and never moves a tool button under the
 * pointer.
 */
export function TitleBandChanges(props: { readonly changes: TitleBandChangesFacts }) {
  const added = props.changes.insertions.toLocaleString("en");
  const removed = props.changes.deletions.toLocaleString("en");
  return (
    <OctantButton
      aria-label={`Uncommitted changes: ${added} lines added, ${removed} removed`}
      className="window-chrome__changes"
      onClick={props.changes.onOpen}
      size="sm"
      title="Review changes"
      type="button"
      variant="bare"
    >
      <span aria-hidden="true" className="window-chrome__changes-added">{`+${added}`}</span>
      <span aria-hidden="true" className="window-chrome__changes-removed">{`−${removed}`}</span>
    </OctantButton>
  );
}
