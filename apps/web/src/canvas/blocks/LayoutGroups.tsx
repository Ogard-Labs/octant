import type { CanvasBlockId, CanvasColumnsBlock, CanvasTabsBlock } from "@octant/contracts/canvas";
import { useState, type ReactNode } from "react";
import {
  OctantTabs,
  OctantTabsList,
  OctantTabsPanel,
  OctantTabsTab,
} from "../../ui/base/OctantTabs";

/**
 * Tabs and columns arrange blocks the document already holds. The document
 * hands each group a way to draw its children, so a child keeps its comment
 * marker and its runtime exactly as it has outside a group.
 */
export function CanvasLayoutGroup({
  block,
  renderChildren,
}: {
  readonly block: CanvasTabsBlock | CanvasColumnsBlock;
  readonly renderChildren: (blockIds: ReadonlyArray<CanvasBlockId>) => ReactNode;
}) {
  return block.kind === "tabs" ? (
    <CanvasTabs block={block} renderChildren={renderChildren} />
  ) : (
    <CanvasColumns block={block} renderChildren={renderChildren} />
  );
}

/**
 * The selected tab is the reader's view state. It lives here and nowhere
 * else: switching sends nothing to the host and never revises the Canvas, so
 * two people reading one version can each be on a different tab. The strip
 * is a tablist whose arrow keys, Home, and End move between tabs.
 */
function CanvasTabs({
  block,
  renderChildren,
}: {
  readonly block: CanvasTabsBlock;
  readonly renderChildren: (blockIds: ReadonlyArray<CanvasBlockId>) => ReactNode;
}) {
  const [selected, setSelected] = useState(0);
  // A revision may remove panes; the reader falls back to the first.
  const shown = selected < block.panes.length ? selected : 0;
  return (
    <OctantTabs
      className="canvas-tabs"
      data-block-kind="tabs"
      onValueChange={(value) => {
        if (typeof value === "number") setSelected(value);
      }}
      value={shown}
    >
      <OctantTabsList aria-label="Sections" className="canvas-tabs__list surface-tabs">
        {block.panes.map((pane, index) => (
          <OctantTabsTab className="canvas-tabs__tab" key={index} value={index}>
            {pane.label}
          </OctantTabsTab>
        ))}
      </OctantTabsList>
      {block.panes.map((pane, index) => (
        <OctantTabsPanel className="canvas-tabs__panel" key={index} value={index}>
          {renderChildren(pane.blockIds)}
        </OctantTabsPanel>
      ))}
    </OctantTabs>
  );
}

/**
 * Two to four tracks side by side. The tracks share the row equally and fold
 * into one column when the Canvas itself is narrow, measured on the Canvas
 * rather than the window, because a sidebar Canvas is narrow on a wide screen.
 */
function CanvasColumns({
  block,
  renderChildren,
}: {
  readonly block: CanvasColumnsBlock;
  readonly renderChildren: (blockIds: ReadonlyArray<CanvasBlockId>) => ReactNode;
}) {
  return (
    <div className="canvas-columns" data-block-kind="columns">
      <div className="canvas-columns__grid" data-tracks={block.tracks.length}>
        {block.tracks.map((track, index) => (
          <div className="canvas-columns__track" key={index}>
            {renderChildren(track.blockIds)}
          </div>
        ))}
      </div>
    </div>
  );
}
