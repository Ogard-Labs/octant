import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasInventoryEntry, ProjectId } from "@octant/contracts";
import { useEffect, useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ProjectCanvasInventoryProps {
  readonly client?: CanvasClient;
  readonly onOpenCanvas: (entry: CanvasInventoryEntry) => void;
  readonly projectId: ProjectId;
}

export function ProjectCanvasInventory(props: ProjectCanvasInventoryProps) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<ReadonlyArray<CanvasInventoryEntry>>([]);
  const [status, setStatus] = useState("");
  const hideWhenEmpty =
    query.trim() === "" && entries.length === 0 && status === "No canvases in this Project yet.";

  useEffect(() => {
    let alive = true;
    if (props.client === undefined) {
      setEntries([]);
      setStatus("Canvas inventory is unavailable.");
      return () => {
        alive = false;
      };
    }
    setStatus("Loading canvases…");
    void props.client
      .inventory(props.projectId, query)
      .then((list) => {
        if (!alive) return;
        setEntries(list.entries);
        setStatus(list.entries.length === 0 ? "No canvases in this Project yet." : "");
      })
      .catch(() => {
        if (!alive) return;
        setEntries([]);
        setStatus("Canvas inventory is unavailable.");
      });
    return () => {
      alive = false;
    };
  }, [props.client, props.projectId, query]);

  const visibleEntries = useMemo(() => entries, [entries]);

  if (hideWhenEmpty) return null;

  return (
    <section className="project-canvas-inventory" aria-label="Canvas inventory">
      <header className="project-canvas-inventory__header">
        <h2>Canvases</h2>
        <label className="sr-only" htmlFor={`canvas-search-${String(props.projectId)}`}>
          Search canvases
        </label>
        <OctantInput
          id={`canvas-search-${String(props.projectId)}`}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search canvases"
          value={query}
        />
      </header>
      <p className="project-canvas-inventory__status" aria-live="polite">
        {status}
      </p>
      <ul className="project-canvas-inventory__list">
        {visibleEntries.map((entry) => (
          <li key={String(entry.canvasId)}>
            <div className="project-canvas-inventory__row">
              <div>
                <strong>{entry.title}</strong>
                <span>
                  v{entry.currentSequence} · {entry.versionCount} version
                  {entry.versionCount === 1 ? "" : "s"}
                </span>
              </div>
              <OctantButton
                onClick={() => props.onOpenCanvas(entry)}
                type="button"
                variant="secondary"
              >
                Open
              </OctantButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
