import type { KeyboardEventHandler, ReactNode } from "react";
import { Info } from "../ui/icons";
import { OctantIconButton } from "../ui/base/OctantButton";

/**
 * A pane's one toolbar row: a 36px bar on the 12px inset with a hairline under
 * it, a name at its left and quiet status or controls at its right.
 *
 * `toolbarLabel` is for a pane whose whole bar is the control strip (the
 * device workbench): it gives the bar the toolbar role and name, and
 * `onKeyDown` carries the strip's arrow-key navigation. `lead` holds a leading
 * control that is not a plain name — a heading must not swallow a switcher.
 */
export function PaneBar(props: {
  readonly title?: ReactNode;
  readonly lead?: ReactNode;
  readonly toolbarLabel?: string;
  readonly onKeyDown?: KeyboardEventHandler<HTMLElement>;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <header
      className={props.className === undefined ? "pane-bar" : `pane-bar ${props.className}`}
      {...(props.toolbarLabel === undefined
        ? {}
        : { "aria-label": props.toolbarLabel, role: "toolbar" })}
      {...(props.onKeyDown === undefined ? {} : { onKeyDown: props.onKeyDown })}
    >
      {props.lead === undefined ? null : <div className="pane-bar__lead">{props.lead}</div>}
      {props.title === undefined ? null : <h3 className="pane-bar__title">{props.title}</h3>}
      <div className="pane-bar__trail">{props.children}</div>
    </header>
  );
}

/** Explanation that does not need a paragraph: an info icon whose tooltip carries it. */
export function InfoTip(props: { readonly text: string }) {
  return (
    <OctantIconButton className="info-tip" label={props.text} size="icon-sm">
      <Info aria-hidden="true" size={14} />
    </OctantIconButton>
  );
}
