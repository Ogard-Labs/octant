import type { CanvasDefinition } from "@octant/contracts/canvas";
import { CANVAS_CARD_SCHEMA_VERSION } from "@octant/contracts/canvas-cards";
import type {
  CanvasRefreshCancelRequest,
  CanvasRefreshDenialCode,
  CanvasRefreshRecipe,
  CanvasRefreshRecipeId,
  CanvasRefreshRequest,
  CanvasRefreshRequestId,
  CanvasRefreshResult,
  CanvasRefreshSkillOption,
} from "@octant/contracts/canvas-refresh";
import type { CanvasSkillContribution } from "@octant/contracts/canvas-skill";
import { Ban, Check, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { CanvasSkillProvenance } from "./CanvasSkillProvenance";

/**
 * Canvas refresh control (C2) and its skill provenance.
 *
 * The renderer forwards a recipe and the canvas's own provenance; the server
 * reauthorizes every field before any side effect, so holding them widens no
 * authority. Denials are rendered from mapped safe copy keyed on the denial
 * code, never the raw server message, and every state is conveyed with an icon
 * *and* words so it never depends on color alone.
 */

/** Everything a refresh request needs beyond its envelope and recipe. */
export type CanvasRefreshRequestBase = Omit<
  CanvasRefreshRequest,
  "schemaVersion" | "kind" | "requestId" | "recipe"
>;

/**
 * Derive the refresh recipe for a canvas.
 *
 * A `CanvasDefinition` carries no stored recipe, so the only refreshable thing
 * a canvas actually has is its canonical source manifest: the recipe is that
 * manifest plus the canvas's own host, mode, workspace, origin thread, provider
 * and model. Every one of those fields is re-checked against immutable canvas
 * provenance server-side, and a source that is not already a canonical canvas
 * source is refused there, so a derived recipe can only ever re-read what the
 * canvas already carries. A canvas with no sources has no recipe — refresh
 * requires at least one canonical source — and gets no control.
 */
export function deriveCanvasRefreshRecipe(
  definition: CanvasDefinition,
  base: CanvasRefreshRequestBase,
  newRecipeId?: () => CanvasRefreshRecipeId,
): CanvasRefreshRecipe | undefined {
  if (definition.sourceManifest.length === 0) return undefined;
  return {
    schemaVersion: CANVAS_CARD_SCHEMA_VERSION,
    kind: "canvas-refresh-recipe",
    recipeId:
      newRecipeId === undefined ? (crypto.randomUUID() as CanvasRefreshRecipeId) : newRecipeId(),
    canvasId: base.canvasId,
    hostId: base.hostId,
    mode: base.mode,
    workspace: base.workspace,
    originThreadId: base.originThreadId,
    providerInstanceId: base.providerInstanceId,
    modelId: base.modelId,
    parameters: [],
    sourceManifest: definition.sourceManifest,
  };
}

const DENIAL_COPY: Record<CanvasRefreshDenialCode, string> = {
  "malformed-request": "This refresh request was not valid.",
  unavailable: "This canvas cannot be refreshed right now.",
  unauthorized: "Refreshing this canvas is not authorized here.",
  "scope-mismatch": "This canvas belongs to a different workspace.",
  "mode-mismatch": "This canvas belongs to a different mode.",
  "origin-thread-mismatch": "This canvas belongs to a different thread.",
  "stale-version": "This canvas changed. Reopen it and refresh again.",
  revoked: "Access to this canvas's sources was withdrawn.",
  offline: "This canvas's sources are offline.",
  incompatible: "This canvas's sources cannot be refreshed.",
  cancelled: "The refresh was cancelled.",
};

/** Safe, metadata-free copy for a refresh denial; never the server message. */
export function safeCanvasRefreshDenialReason(code: CanvasRefreshDenialCode): string {
  return DENIAL_COPY[code];
}

const FAILURE_COPY = "The refresh could not be completed.";
const CANCEL_FAILURE_COPY =
  "The cancellation could not be confirmed. Reopen the canvas to see its current state.";

/** Terminal, user-visible state of the most recent refresh. */
type RefreshRun =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "refreshed" }
  | { readonly kind: "partial" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "denied"; readonly reason: string };

export interface CanvasRefreshPanelProps {
  /** The canvas's refresh recipe; the control exists only because it does. */
  readonly recipe: CanvasRefreshRecipe;
  readonly requestBase: CanvasRefreshRequestBase;
  /** Host-owned dispatch that reauthorizes and runs the refresh server-side. */
  readonly onRefresh: (request: CanvasRefreshRequest) => Promise<CanvasRefreshResult>;
  /** Optional cancellation; enables the Cancel control when the host supports it. */
  readonly onCancel?: (request: CanvasRefreshCancelRequest) => Promise<CanvasRefreshResult>;
  /**
   * Skills the host published as eligible to present this canvas. A derived
   * recipe names no skill of its own and a renderer cannot mint a digest-pinned
   * identity, so this list is the only way a refresh can carry one. Empty or
   * absent means refresh proceeds without a skill contribution.
   */
  readonly skillOptions?: ReadonlyArray<CanvasRefreshSkillOption>;
  /** Mint a request id; defaults to `crypto.randomUUID`. Injectable for tests. */
  readonly newRequestId?: () => CanvasRefreshRequestId;
}

export function CanvasRefreshPanel(props: CanvasRefreshPanelProps) {
  const [run, setRun] = useState<RefreshRun>({ kind: "idle" });
  const [contribution, setContribution] = useState<CanvasSkillContribution | undefined>(undefined);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  // A monotonic token lets a cancellation or a newer refresh supersede a stale
  // in-flight dispatch, so a late resolution can never clobber the UI.
  const token = useRef(0);
  const inFlightRequestId = useRef<CanvasRefreshRequestId | undefined>(undefined);
  const running = run.kind === "running";
  const sourceCount = props.recipe.sourceManifest.length;
  const skillOptions = props.skillOptions ?? [];
  const selectedSkill = skillOptions.find(
    (option) => String(option.skill.qualifiedId) === selectedSkillId,
  );

  async function refresh() {
    const current = (token.current += 1);
    const requestId =
      props.newRequestId === undefined
        ? (crypto.randomUUID() as CanvasRefreshRequestId)
        : props.newRequestId();
    inFlightRequestId.current = requestId;
    // Provenance describes the refresh that produced the current canvas; a new
    // run invalidates it until an accepted result carries one again.
    setContribution(undefined);
    setRun({ kind: "running" });
    try {
      const result = await props.onRefresh({
        schemaVersion: CANVAS_CARD_SCHEMA_VERSION,
        kind: "canvas-refresh",
        requestId,
        // The chosen skill rides on the recipe the server reauthorizes; the
        // recipe's identity is unchanged, so a cancellation still matches.
        recipe:
          selectedSkill === undefined
            ? props.recipe
            : { ...props.recipe, skill: selectedSkill.skill },
        ...props.requestBase,
      });
      if (token.current !== current) return;
      if (result.kind === "accepted" && result.contribution !== undefined) {
        setContribution(result.contribution);
      }
      setRun(interpretResult(result));
    } catch {
      if (token.current !== current) return;
      setRun({ kind: "failed", reason: FAILURE_COPY });
    }
  }

  async function cancel() {
    const requestId = inFlightRequestId.current;
    if (props.onCancel === undefined || requestId === undefined) return;
    // Invalidate the in-flight refresh so its late resolution cannot clobber
    // the authoritative cancellation outcome rendered below.
    const current = (token.current += 1);
    try {
      const result = await props.onCancel({
        schemaVersion: CANVAS_CARD_SCHEMA_VERSION,
        kind: "canvas-refresh-cancel",
        requestId,
        recipeId: props.recipe.recipeId,
        canvasId: props.requestBase.canvasId,
      });
      if (token.current !== current) return;
      // The server's cancel receipt is authoritative and can lose the race:
      // a `ready` receipt means the refresh completed and a new version was
      // saved, so the outcome is interpreted like any other refresh result
      // rather than blindly claiming a cancellation that never happened.
      if (result.kind === "accepted" && result.contribution !== undefined) {
        setContribution(result.contribution);
      }
      setRun(interpretResult(result));
    } catch {
      if (token.current !== current) return;
      // Without a receipt the refresh outcome is unknown; say so instead of
      // claiming the previous canvas is unchanged.
      setRun({ kind: "failed", reason: CANCEL_FAILURE_COPY });
    }
  }

  return (
    <section className="canvas-refresh" aria-label="Canvas refresh" data-run={run.kind}>
      <h3 className="canvas-refresh__title">Refresh</h3>
      <p className="canvas-refresh__description" id="canvas-refresh-description">
        Re-reads {sourceCount === 1 ? "this canvas's source" : `all ${sourceCount} canvas sources`}{" "}
        and saves a new version when every source is ready.
      </p>
      {skillOptions.length === 0 ? null : (
        <label className="canvas-refresh__skill">
          <span>Presentation skill</span>
          <OctantNativeSelect
            data-testid="canvas-refresh-skill"
            disabled={running}
            value={selectedSkillId}
            onChange={(event) => setSelectedSkillId(event.target.value)}
          >
            <option value="">No skill</option>
            {skillOptions.map((option) => (
              <option
                key={String(option.skill.qualifiedId)}
                value={String(option.skill.qualifiedId)}
              >
                {option.displayName}
              </option>
            ))}
          </OctantNativeSelect>
        </label>
      )}
      <div className="canvas-refresh__row">
        <OctantButton
          type="button"
          size="sm"
          variant="secondary"
          aria-describedby="canvas-refresh-description"
          aria-disabled={running ? true : undefined}
          data-testid="canvas-refresh-submit"
          onClick={() => {
            if (running) return;
            void refresh();
          }}
        >
          {running ? (
            <LoaderCircle
              aria-hidden="true"
              className="canvas-refresh__spinner"
              size={14}
              strokeWidth={2}
            />
          ) : (
            <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
          )}
          <span>Refresh canvas</span>
        </OctantButton>
        {running && props.onCancel !== undefined ? (
          <OctantButton
            type="button"
            size="sm"
            variant="ghost"
            data-testid="canvas-refresh-cancel"
            onClick={() => void cancel()}
          >
            Cancel refresh
          </OctantButton>
        ) : null}
      </div>
      <RefreshStatus run={run} />
      {contribution === undefined ? null : <CanvasSkillProvenance contribution={contribution} />}
    </section>
  );
}

function RefreshStatus(props: { readonly run: RefreshRun }) {
  const { run } = props;
  if (run.kind === "idle") return null;
  const isError = run.kind === "denied" || run.kind === "failed";
  const text =
    run.kind === "running"
      ? "Refreshing…"
      : run.kind === "refreshed"
        ? "Canvas refreshed."
        : run.kind === "partial"
          ? "Some sources could not be refreshed. The previous canvas is unchanged."
          : run.kind === "cancelled"
            ? "Refresh cancelled."
            : run.reason;
  return (
    <p
      className="canvas-refresh__status"
      data-run={run.kind}
      data-testid="canvas-refresh-status"
      role={isError ? "alert" : "status"}
      aria-live="polite"
    >
      {run.kind === "refreshed" ? (
        <Check aria-hidden="true" size={14} strokeWidth={2} />
      ) : isError ? (
        <Ban aria-hidden="true" size={14} strokeWidth={1.8} />
      ) : run.kind === "partial" ? (
        <TriangleAlert aria-hidden="true" size={14} strokeWidth={1.8} />
      ) : null}
      <span>{text}</span>
    </p>
  );
}

/** Reduce a server refresh result to a safe, terminal UI state. */
function interpretResult(result: CanvasRefreshResult): RefreshRun {
  if (result.kind === "denied") {
    return { kind: "denied", reason: safeCanvasRefreshDenialReason(result.denialCode) };
  }
  switch (result.receipt.outcome) {
    case "ready":
      return { kind: "refreshed" };
    case "limited":
    case "partial":
      return { kind: "partial" };
    case "cancelled":
      return { kind: "cancelled" };
    case "failed":
      return { kind: "failed", reason: FAILURE_COPY };
  }
}
