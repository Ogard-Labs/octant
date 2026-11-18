import type { ReactNode } from "react";

/**
 * The row above a new thread's box: the thread kind, the Project, where it
 * runs, and "Create from…" at the row's end. Every start surface draws it, so
 * choosing Chat or a folder never moves a chip: a chip only some modes use
 * keeps its slot (hidden, not collapsed), and "Create from…" stands at the
 * row's end rather than after whichever chips happen to be present.
 */
export function ComposerStartTray(props: {
  readonly kind?: ReactNode;
  /** The Project chooser. Chat keeps its own under the box, so the slot stays empty there. */
  readonly project?: ReactNode;
  readonly branch?: ReactNode;
  readonly environment?: ReactNode;
  readonly createFrom?: ReactNode;
  /** Controls that stand just before "Create from…", such as the workspace choice. */
  readonly trailing?: ReactNode;
}) {
  const held = props.project === undefined || props.project === null;
  return (
    <div className="composer-tray composer-tray--start" aria-label="Thread context">
      <div className="composer-tray__leading">
        {props.kind}
        <div
          className="composer-tray__slot"
          data-held={held ? "true" : undefined}
          data-slot="project"
          {...(held ? { "aria-hidden": true } : {})}
        >
          {props.project}
        </div>
        {props.branch}
        {props.environment}
      </div>
      <div className="composer-tray__trailing">
        {props.trailing}
        {props.createFrom}
      </div>
    </div>
  );
}

/**
 * The cell under the box where Chat shows its Project. A mode that keeps its
 * Project in the row above leaves it empty rather than collapsed, so the model
 * and the rest of the row stay put when the thread kind changes.
 */
export function ComposerRowSlot() {
  return <span aria-hidden="true" className="composer-row__slot" data-slot="project-row" />;
}
