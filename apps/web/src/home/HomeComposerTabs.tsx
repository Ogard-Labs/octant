import { useState, type ReactNode } from "react";
import { OctantTabs, OctantTabsList, OctantTabsPanel, OctantTabsTab } from "../ui/base/OctantTabs";
import "./home.css";

/**
 * What a start screen adds above its composer: the Running tab. The count is
 * the sidebar's own Running count, handed in by the shell so the two cannot
 * disagree; `running` is the tab's body, mounted only while the tab is open.
 */
export interface HomeComposerTabsSlot {
  readonly runningCount: number;
  readonly running: ReactNode;
}

type HomeComposerTab = "new-task" | "running";

/**
 * The start screen's two tabs: **New task** (the composer, as it always was)
 * and **Running**. The composer stays mounted while Running is open, only
 * hidden, so a half-written prompt, the chosen Project and model, and any
 * attachments are all still there when the person comes back. A screen with no
 * slot renders its composer unchanged.
 */
export function HomeComposerTabs(props: {
  readonly slot: HomeComposerTabsSlot | undefined;
  readonly children: ReactNode;
}) {
  const [tab, setTab] = useState<HomeComposerTab>("new-task");
  const { slot } = props;
  if (slot === undefined) return <>{props.children}</>;
  return (
    <OctantTabs
      className="home-composer-tabs"
      onValueChange={(value) => {
        if (value === "new-task" || value === "running") setTab(value);
      }}
      value={tab}
    >
      <OctantTabsList aria-label="Start" className="surface-tabs home-composer-tabs__list">
        <OctantTabsTab value="new-task">New task</OctantTabsTab>
        <OctantTabsTab value="running">
          Running
          {slot.runningCount > 0 ? (
            <>
              {" "}
              <span className="oct-meta home-composer-tabs__count">{slot.runningCount}</span>
            </>
          ) : null}
        </OctantTabsTab>
      </OctantTabsList>
      <OctantTabsPanel
        className="home-composer-tabs__panel"
        keepMounted
        tabIndex={-1}
        value="new-task"
      >
        {props.children}
      </OctantTabsPanel>
      <OctantTabsPanel className="home-composer-tabs__panel" tabIndex={-1} value="running">
        {slot.running}
      </OctantTabsPanel>
    </OctantTabs>
  );
}
