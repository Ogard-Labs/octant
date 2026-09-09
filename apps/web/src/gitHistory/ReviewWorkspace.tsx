import { lazy, Suspense, useMemo, useState } from "react";
import { createGitHistoryClient } from "@octant/client-runtime/git-history-client";
import type { DockReviewToolProps } from "../shell/DockReviewTool";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { ShellState } from "../shell/ShellState";
import "./git-history.css";

const WorkingTree = lazy(() =>
  import("../shell/DockReviewTool").then((module) => ({ default: module.DockReviewTool })),
);
const History = lazy(() =>
  import("./GitHistoryPanel").then((module) => ({ default: module.GitHistoryPanel })),
);

/** Review owns the two Git views. Neither view is loaded until it is selected. */
export function ReviewWorkspace(props: DockReviewToolProps) {
  const checkoutId = props.checkoutId ?? props.controller?.activeView?.checkout.id;
  return (
    <BoundReview
      key={`${props.threadId}:${checkoutId ?? ""}:${props.serverUrl ?? ""}`}
      {...props}
      {...(checkoutId === undefined ? {} : { checkoutId })}
    />
  );
}

function BoundReview(props: DockReviewToolProps) {
  const [view, setView] = useState("changes");
  const [openedHistory, setOpenedHistory] = useState(false);
  const reader = useMemo(
    () =>
      props.serverUrl === undefined || props.windowCapability === undefined
        ? undefined
        : createGitHistoryClient({
            baseUrl: props.serverUrl,
            windowCapability: props.windowCapability,
            fetch: globalThis.fetch,
          }),
    [props.serverUrl, props.windowCapability],
  );
  return (
    <div className="git-history">
      <div className="git-history__toolbar">
        <OctantToggleGroup
          aria-label="Review view"
          value={[view]}
          onValueChange={(values) => {
            const selected = values[0];
            if (selected) {
              setView(selected);
              if (selected === "history") setOpenedHistory(true);
            }
          }}
        >
          <OctantToggleGroupItem value="changes">Working tree</OctantToggleGroupItem>
          <OctantToggleGroupItem value="history">History</OctantToggleGroupItem>
        </OctantToggleGroup>
      </div>
      <div className="git-history__list" hidden={view !== "changes"}>
        <Suspense fallback={<ShellState state="loading" title="Loading changes" />}>
          <WorkingTree {...props} />
        </Suspense>
      </div>
      {openedHistory ? (
        <div className="git-history__list" hidden={view !== "history"}>
          {reader === undefined || props.checkoutId === undefined ? (
            <ShellState
              state="neutral"
              title="History is unavailable"
              message="Reconnect to this checkout to browse its history."
            />
          ) : (
            <Suspense fallback={<ShellState state="loading" title="Loading history" />}>
              <History reader={reader} threadId={props.threadId} checkoutId={props.checkoutId} />
            </Suspense>
          )}
        </div>
      ) : null}
    </div>
  );
}
