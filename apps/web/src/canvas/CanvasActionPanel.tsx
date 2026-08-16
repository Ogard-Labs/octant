import type { CanvasActionBlock, CanvasActionResult } from "@octant/contracts/canvas-actions";
import {
  canvasActionEffectLabel,
  safeCanvasActionDenialReason,
  type CanvasActionAvailability,
} from "@octant/domain/canvas-action-availability-policy";
import { Ban, Check, Eye, LoaderCircle, LockKeyhole, Pencil, ShieldAlert } from "lucide-react";
import { useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * Accessible renderer for declarative Canvas typed actions (D3).
 *
 * Every action is either offered as a real, keyboard-operable button or shown
 * visibly disabled with a safe, metadata-free reason. Availability is decided by
 * the injected pure policy verdict; the renderer never mints authority and never
 * displays the raw server denial `message`, only mapped safe copy. Read vs.
 * mutating and approval-gated states are conveyed with icons *and* words so the
 * distinction never depends on color alone (design §7 Typed actions).
 */

/** Terminal, per-action result the renderer announces after a dispatch. */
type ActionRun =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "completed"; readonly message: string }
  | { readonly kind: "requested"; readonly message: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface CanvasActionPanelProps {
  readonly actions: readonly CanvasActionBlock[];
  /** Pure presentation verdict for a block; see `evaluateCanvasActionAvailability`. */
  readonly availability: (block: CanvasActionBlock) => CanvasActionAvailability;
  /** Host-owned dispatch that reauthorizes and executes the action server-side. */
  readonly onExecute: (block: CanvasActionBlock) => Promise<CanvasActionResult>;
  /** Optional cancellation of an in-flight action; enables the Cancel control. */
  readonly onCancel?: (block: CanvasActionBlock) => Promise<CanvasActionResult>;
  readonly heading?: string;
}

const FAILURE_COPY = "The action could not be completed.";
const CANCEL_FAILURE_COPY = "The cancellation could not be confirmed.";

export function CanvasActionPanel(props: CanvasActionPanelProps) {
  const [runs, setRuns] = useState<ReadonlyMap<string, ActionRun>>(new Map());
  // A monotonic token per block lets a cancellation or a newer run supersede a
  // stale in-flight dispatch, so a late resolution can never clobber the UI.
  const tokens = useRef<Map<string, number>>(new Map());

  function runOf(blockId: string): ActionRun {
    return runs.get(blockId) ?? { kind: "idle" };
  }

  function setRun(blockId: string, run: ActionRun) {
    setRuns((prev) => {
      const next = new Map(prev);
      next.set(blockId, run);
      return next;
    });
  }

  function nextToken(blockId: string): number {
    const value = (tokens.current.get(blockId) ?? 0) + 1;
    tokens.current.set(blockId, value);
    return value;
  }

  async function execute(block: CanvasActionBlock) {
    const blockId = String(block.blockId);
    const token = nextToken(blockId);
    setRun(blockId, { kind: "running" });
    try {
      const result = await props.onExecute(block);
      if (tokens.current.get(blockId) !== token) return;
      setRun(blockId, interpretResult(result));
    } catch {
      if (tokens.current.get(blockId) !== token) return;
      setRun(blockId, { kind: "failed", reason: FAILURE_COPY });
    }
  }

  async function cancel(block: CanvasActionBlock) {
    if (props.onCancel === undefined) return;
    const blockId = String(block.blockId);
    // Invalidate the in-flight execute so its resolution is ignored, and take
    // this cancellation's own token so a newer dispatch supersedes it too.
    const token = nextToken(blockId);
    try {
      // The server decides what happened: a cancellation can lose the race to
      // completion, or be denied outright. Announcing "Cancelled" regardless
      // would contradict a completed action.
      const result = await props.onCancel(block);
      if (tokens.current.get(blockId) !== token) return;
      setRun(blockId, interpretResult(result));
    } catch {
      if (tokens.current.get(blockId) !== token) return;
      setRun(blockId, { kind: "failed", reason: CANCEL_FAILURE_COPY });
    }
  }

  return (
    <section className="canvas-actions" aria-label={props.heading ?? "Canvas actions"}>
      <h3 className="canvas-actions__title">{props.heading ?? "Actions"}</h3>
      {props.actions.length === 0 ? (
        <p className="canvas-actions__empty" role="note">
          This canvas has no actions.
        </p>
      ) : (
        <ul className="canvas-actions__list">
          {props.actions.map((block) => (
            <li key={String(block.blockId)}>
              <CanvasActionItem
                block={block}
                availability={props.availability(block)}
                run={runOf(String(block.blockId))}
                onExecute={() => execute(block)}
                {...(props.onCancel === undefined ? {} : { onCancel: () => cancel(block) })}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CanvasActionItem(props: {
  readonly block: CanvasActionBlock;
  readonly availability: CanvasActionAvailability;
  readonly run: ActionRun;
  readonly onExecute: () => void;
  readonly onCancel?: () => void;
}) {
  const { block, availability, run } = props;
  const blockId = String(block.blockId);
  const disabled = availability.state !== "available";
  const running = run.kind === "running";
  const descriptionId = `${blockId}-description`;
  const reasonId = `${blockId}-reason`;
  const statusId = `${blockId}-status`;
  const effectLabel = canvasActionEffectLabel(availability.capability);

  // A disabled action stays in the accessibility tree via `aria-disabled` (not
  // the native `disabled` attribute) so a screen-reader user can focus it and
  // hear the safe reason instead of the control silently disappearing.
  const describedBy = [
    block.description === undefined ? undefined : descriptionId,
    disabled ? reasonId : undefined,
    run.kind === "idle" || running ? undefined : statusId,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  return (
    <div
      className="canvas-action"
      role="group"
      aria-label={block.label}
      data-availability={availability.state}
      data-effect={availability.capability.effect}
      data-run={run.kind}
    >
      <div className="canvas-action__row">
        <OctantButton
          type="button"
          size="sm"
          variant={availability.capability.effect === "mutate" ? "secondary" : "outline"}
          aria-disabled={disabled || running ? true : undefined}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          onClick={() => {
            if (disabled || running) return;
            props.onExecute();
          }}
        >
          <ActionEffectIcon availability={availability} running={running} />
          <span>{block.label}</span>
        </OctantButton>
        <span className="canvas-action__effect">
          {availability.capability.effect === "mutate" ? (
            <Pencil aria-hidden="true" size={13} strokeWidth={1.8} />
          ) : (
            <Eye aria-hidden="true" size={13} strokeWidth={1.8} />
          )}
          <span>{effectLabel}</span>
        </span>
        {availability.requiresApproval ? (
          <span className="canvas-action__approval">
            <ShieldAlert aria-hidden="true" size={13} strokeWidth={1.8} />
            <span>Needs approval</span>
          </span>
        ) : null}
        {running && props.onCancel !== undefined ? (
          <OctantButton type="button" size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </OctantButton>
        ) : null}
      </div>

      {block.description === undefined ? null : (
        <p className="canvas-action__description" id={descriptionId}>
          {block.description}
        </p>
      )}

      {disabled ? (
        <p className="canvas-action__reason" id={reasonId} role="note">
          {availability.state === "unauthorized" ? (
            <LockKeyhole aria-hidden="true" size={13} strokeWidth={1.8} />
          ) : (
            <Ban aria-hidden="true" size={13} strokeWidth={1.8} />
          )}
          <span>{availability.reason}</span>
        </p>
      ) : null}

      <ActionStatus run={run} statusId={statusId} />
    </div>
  );
}

function ActionEffectIcon(props: {
  readonly availability: CanvasActionAvailability;
  readonly running: boolean;
}) {
  if (props.running) {
    return (
      <LoaderCircle
        aria-hidden="true"
        className="canvas-action__spinner"
        size={14}
        strokeWidth={2}
      />
    );
  }
  if (props.availability.state === "unauthorized") {
    return <LockKeyhole aria-hidden="true" size={14} strokeWidth={1.8} />;
  }
  if (props.availability.state === "unavailable") {
    return <Ban aria-hidden="true" size={14} strokeWidth={1.8} />;
  }
  return props.availability.capability.effect === "mutate" ? (
    <Pencil aria-hidden="true" size={14} strokeWidth={1.8} />
  ) : (
    <Eye aria-hidden="true" size={14} strokeWidth={1.8} />
  );
}

function ActionStatus(props: { readonly run: ActionRun; readonly statusId: string }) {
  const { run } = props;
  if (run.kind === "idle") return null;
  if (run.kind === "running") {
    return (
      <p className="canvas-action__status" role="status" aria-live="polite">
        Running…
      </p>
    );
  }
  const isError = run.kind === "denied" || run.kind === "failed";
  const text =
    run.kind === "completed" || run.kind === "requested"
      ? run.message
      : run.kind === "cancelled"
        ? "Cancelled."
        : run.reason;
  return (
    <p
      className="canvas-action__status"
      id={props.statusId}
      role={isError ? "alert" : "status"}
      aria-live="polite"
      data-run={run.kind}
    >
      {run.kind === "completed" ? (
        <Check aria-hidden="true" size={13} strokeWidth={2} />
      ) : isError ? (
        <Ban aria-hidden="true" size={13} strokeWidth={1.8} />
      ) : null}
      <span>{text}</span>
    </p>
  );
}

/**
 * Reduce a server action result to a safe, terminal UI state. A denial is
 * rendered from mapped safe copy keyed on the denial code, never the raw server
 * message, so no host, provider, thread, or Project metadata can leak.
 */
function interpretResult(result: CanvasActionResult): ActionRun {
  if (result.kind === "denied") {
    return { kind: "denied", reason: safeCanvasActionDenialReason(result.denialCode) };
  }
  switch (result.receipt.outcome) {
    case "completed":
      return { kind: "completed", message: "Done." };
    case "requested":
      return { kind: "requested", message: "Requested." };
    case "cancelled":
      return { kind: "cancelled" };
    case "failed":
      return { kind: "failed", reason: FAILURE_COPY };
  }
}
