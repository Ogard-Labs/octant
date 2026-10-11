import type { CanvasColumnsBlock, CanvasTabsBlock } from "@octant/contracts/canvas";
import { useState, type ReactNode } from "react";
import {
  OctantTabs,
  OctantTabsList,
  OctantTabsPanel,
  OctantTabsTab,
} from "../../ui/base/OctantTabs";

/**
 * Tabs and columns arrange blocks the document already holds. The document
 * hands each group a way to draw a pane's or track's children in reading
 * order, so a child keeps its comment marker and its runtime exactly as it
 * has outside a group, and a dashboard in a pane is the grid it is anywhere.
 */
export function CanvasLayoutGroup({
  block,
  renderSection,
}: {
  readonly block: CanvasTabsBlock | CanvasColumnsBlock;
  readonly renderSection: (index: number) => ReactNode;
}) {
  return block.kind === "tabs" ? (
    <CanvasTabs block={block} renderSection={renderSection} />
  ) : (
    <CanvasColumns block={block} renderSection={renderSection} />
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
  renderSection,
}: {
  readonly block: CanvasTabsBlock;
  readonly renderSection: (index: number) => ReactNode;
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
          {renderSection(index)}
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
  renderSection,
}: {
  readonly block: CanvasColumnsBlock;
  readonly renderSection: (index: number) => ReactNode;
}) {
  return (
    <div className="canvas-columns" data-block-kind="columns">
      <div className="canvas-columns__grid" data-tracks={block.tracks.length}>
        {block.tracks.map((track, index) => (
          <div className="canvas-columns__track" key={index}>
            {renderSection(index)}
          </div>
        ))}
      </div>
    </div>
  );
}
