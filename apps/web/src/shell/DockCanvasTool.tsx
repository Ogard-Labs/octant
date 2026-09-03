import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { CanvasId } from "@octant/contracts/canvas";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { decodeWorkspaceTab, decodeWorkspaceTabId } from "@octant/contracts";
import { lazy, Suspense, useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { isAuthorizedCanvasDocument } from "./dockToolAvailability";
import { ShellState } from "./ShellState";

const CanvasWorkspaceTab = lazy(() =>
  import("../canvas/CanvasWorkspaceTab").then((module) => ({
    default: module.CanvasWorkspaceTab,
  })),
);

const dockCanvasTabId = decodeWorkspaceTabId("90000000-0000-4000-8000-000000000007");

export interface DockCanvasToolProps {
  readonly client?: CanvasClient;
  readonly mode: OctantMode;
  readonly projectId?: ProjectId;
  readonly threadId: string;
}

/**
 * Opens the thread's existing authorized Canvas in the dock.
 *
 * The document is the host's; this surface never copies content or history,
 * and it never offers a create form. A thread with no authorized document is
 * empty-handed rather than a blank canvas.
 */
export function DockCanvasTool(props: DockCanvasToolProps) {
  const [cards, setCards] = useState<ReadonlyArray<CanvasThreadReferenceCard>>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [openCanvasId, setOpenCanvasId] = useState<CanvasId | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    if (props.client === undefined) {
      setCards([]);
      setStatus("unavailable");
      return () => {
        alive = false;
      };
    }
    setStatus("loading");
    void props.client
      .threadReferenceCards({
        mode: props.mode,
        threadId: props.threadId,
        projectId: props.projectId ?? null,
      })
      .then((outcome) => {
        if (!alive) return;
        const authorized = outcome.cards.filter(isAuthorizedCanvasDocument);
        setCards(authorized);
        setOpenCanvasId(authorized.length === 1 ? authorized[0]?.canvasId : undefined);
        setStatus("ready");
      })
      .catch(() => {
        if (!alive) return;
        setCards([]);
        setStatus("unavailable");
      });
    return () => {
      alive = false;
    };
  }, [props.client, props.mode, props.projectId, props.threadId]);

  if (status === "loading") {
    return (
      <ShellState message="Loading this thread's Canvas." state="loading" title="Loading Canvas" />
    );
  }
  if (status === "unavailable" || cards.length === 0) {
    return (
      <ShellState
        message="This thread has no authorized Canvas document to open."
        state="neutral"
        title="Canvas is unavailable"
      />
    );
  }

  const openCard =
    openCanvasId === undefined
      ? undefined
      : cards.find((card) => String(card.canvasId) === String(openCanvasId));
  if (openCard !== undefined) {
    const projectId = canvasProjectId(openCard, props.projectId);
    if (projectId === undefined) {
      return (
        <ShellState
          message="This Canvas has no Project this window can address."
          state="neutral"
          title="Canvas is unavailable"
        />
      );
    }
    let tab: ReturnType<typeof decodeWorkspaceTab>;
    try {
      tab = decodeWorkspaceTab({
        kind: "canvas",
        id: dockCanvasTabId,
        mode: openCard.scope.mode,
        title: openCard.title,
        canvasId: openCard.canvasId,
        projectId,
      });
    } catch {
      return (
        <ShellState
          message="This Canvas could not be opened in the dock."
          state="neutral"
          title="Canvas is unavailable"
        />
      );
    }
    if (tab.kind !== "canvas") {
      return (
        <ShellState
          message="This Canvas could not be opened in the dock."
          state="neutral"
          title="Canvas is unavailable"
        />
      );
    }
    return (
      <div className="dock-canvas-tool">
        {cards.length === 1 ? null : (
          <OctantButton onClick={() => setOpenCanvasId(undefined)} type="button" variant="ghost">
            All canvases
          </OctantButton>
        )}
        <Suspense
          fallback={<ShellState message="Loading canvas." state="loading" title="Loading Canvas" />}
        >
          <CanvasWorkspaceTab client={props.client} tab={tab} />
        </Suspense>
      </div>
    );
  }

  return (
    <section aria-label="Canvas documents" className="dock-canvas-tool">
      <ul className="dock-canvas-tool__list">
        {cards.map((card) => (
          <li key={String(card.canvasId)}>
            <OctantButton
              onClick={() => setOpenCanvasId(card.canvasId)}
              type="button"
              variant="secondary"
            >
              {`Open ${card.title}`}
            </OctantButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

function canvasProjectId(
  card: CanvasThreadReferenceCard,
  fallback: ProjectId | undefined,
): ProjectId | undefined {
  const scoped = "projectId" in card.scope.workspace ? card.scope.workspace.projectId : undefined;
  if (scoped !== null && scoped !== undefined) return scoped;
  return fallback;
}
