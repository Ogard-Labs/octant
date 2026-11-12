import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasActor,
  decodeCanvasVersionId,
  type CanvasDesignSystem,
  type CanvasId,
} from "@octant/contracts/canvas";
import type { DesignSystemList, DesignSystemLocation } from "@octant/contracts/design-systems";
import { decodeUtcTimestamp } from "@octant/contracts";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";

// The host stamps its own local person on the switch and ignores what is sent;
// this is the same identity the Canvas surface sends for a drag or a deck.
const LOCAL_PERSON = decodeCanvasActor({
  kind: "local-user",
  actorId: "00000000-0000-4000-8000-000000000002",
});

export interface CanvasDesignSystemPanelProps {
  readonly client: Pick<CanvasClient, "listDesignSystems" | "applyDesignSystem">;
  readonly canvasId: CanvasId;
  /** The design system the version on screen follows, if any. */
  readonly current: CanvasDesignSystem | undefined;
  readonly expectedSequence: number;
  /** Reload the Canvas after the host journaled the switch. */
  readonly onApplied: () => Promise<void>;
}

type Listed =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly list: DesignSystemList };

/**
 * Switch the design system a Canvas follows: any of its Project's
 * `DESIGN.md` files, or none. The host reads the chosen file and journals the
 * switch as a new version, so the change shows in history and can be undone
 * by switching back. Typed blocks and brand designs redraw at once.
 */
export function CanvasDesignSystemPanel(props: CanvasDesignSystemPanelProps) {
  const [listed, setListed] = useState<Listed>({ status: "loading" });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const { client, canvasId } = props;

  useEffect(() => {
    let alive = true;
    const list = client.listDesignSystems;
    if (list === undefined) {
      setListed({ status: "failed" });
      return;
    }
    list(String(canvasId))
      .then((value) => {
        if (alive) setListed({ status: "ready", list: value });
      })
      .catch(() => {
        if (alive) setListed({ status: "failed" });
      });
    return () => {
      alive = false;
    };
  }, [client, canvasId]);

  async function apply(location: DesignSystemLocation | null, label: string) {
    const applyDesignSystem = client.applyDesignSystem;
    if (applyDesignSystem === undefined) return;
    setPending(true);
    setMessage(undefined);
    try {
      const result = await applyDesignSystem({
        kind: "canvas-design-system-apply",
        canvasId,
        versionId: decodeCanvasVersionId(globalThis.crypto.randomUUID()),
        actor: LOCAL_PERSON,
        expectedSequence: props.expectedSequence,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        issuedAt: decodeUtcTimestamp(new Date().toISOString()),
        designSystem: location,
      });
      if (result.kind === "accepted") {
        await props.onApplied();
        setMessage(label);
      } else {
        setMessage(result.message);
        if (result.denialCode === "stale-version") await props.onApplied();
      }
    } catch {
      setMessage("The design system could not be switched. Try again.");
    } finally {
      setPending(false);
    }
  }

  const systems = listed.status === "ready" ? listed.list.systems : [];
  return (
    <section aria-label="Canvas design system" className="canvas-design-system-panel">
      <p className="canvas-design-system-panel__current">
        {props.current === undefined
          ? "This Canvas follows no design system: its charts and tables use the workspace colours."
          : `This Canvas follows ${props.current.name}${props.current.source === undefined ? "" : ` (${props.current.source})`}. Its charts, tables, and brand designs draw in its colours.`}
      </p>
      {listed.status === "loading" ? <p>Reading the Project's design systems…</p> : null}
      {listed.status === "failed" ? (
        <OctantAlert tone="warning">The Project's design systems could not be read.</OctantAlert>
      ) : null}
      {listed.status === "ready" && systems.length === 0 ? (
        <p>This Project has no DESIGN.md. Create one from the Project's Design system row.</p>
      ) : null}
      {systems.length === 0 ? null : (
        <ul aria-label="Design systems" className="canvas-design-system-panel__list">
          {systems.map((system) => {
            // A Canvas records where its design system came from as a person
            // reads it: relative in the main folder, else under its folder.
            const applied =
              props.current?.source === system.path ||
              props.current?.source === `${system.folder}/${system.path}`;
            return (
              <li key={`${system.folder}\u0000${system.path}`}>
                {/* The applied one stays a button: the Canvas keeps a copy of the
                    tokens, so choosing it again is how an edit to the file reaches it. */}
                <OctantButton
                  aria-pressed={applied}
                  disabled={pending}
                  onClick={() =>
                    void apply(
                      { folder: system.folder, path: system.path },
                      applied
                        ? `This Canvas now has the latest of ${system.name}.`
                        : `This Canvas now follows ${system.name}.`,
                    )
                  }
                  size="sm"
                  type="button"
                  variant={applied ? "secondary" : "ghost"}
                >
                  {system.name}
                </OctantButton>
                <span className="canvas-design-system-panel__path">
                  {applied
                    ? `${system.path} · applied; choose it again after editing the file`
                    : system.path}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {props.current === undefined ? null : (
        <OctantButton
          disabled={pending}
          onClick={() => void apply(null, "This Canvas follows no design system now.")}
          size="sm"
          type="button"
          variant="ghost"
        >
          Use no design system
        </OctantButton>
      )}
      {message === undefined ? null : (
        <p className="canvas-design-system-panel__status" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
