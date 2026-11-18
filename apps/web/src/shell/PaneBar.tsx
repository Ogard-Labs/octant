import type { ReactNode } from "react";
import { Info } from "../ui/icons";
import { OctantIconButton } from "../ui/base/OctantButton";

/**
 * A pane's one toolbar row: a 36px bar on the 12px inset with a hairline under
 * it, a name at its left and quiet status or controls at its right.
 */
export function PaneBar(props: { readonly title?: ReactNode; readonly children?: ReactNode }) {
  return (
    <header className="pane-bar">
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
