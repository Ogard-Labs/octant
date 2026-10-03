import type {
  CanvasExportApprovalCard,
  CanvasExportDecideRequest,
  CanvasExportDecideResult,
  CanvasExportDelivery,
  CanvasExportOfferList,
  CanvasExportPrepareRequest,
  CanvasExportPrepareResult,
  CanvasExportTargetOffer,
  CanvasExportTargetStatus,
} from "@octant/contracts/canvas-export";
import { useState } from "react";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface CanvasExportPanelProps {
  readonly offers: CanvasExportOfferList;
  readonly onPrepare: (request: CanvasExportPrepareRequest) => Promise<CanvasExportPrepareResult>;
  readonly onDecide: (request: CanvasExportDecideRequest) => Promise<CanvasExportDecideResult>;
}

const STATUS_LABEL: Record<CanvasExportTargetStatus, string> = {
  "not-connected": "Not connected",
  ready: "Ready",
  refused: "Refused",
};

/**
 * Asks the host to render a Canvas, then shows the payload and destination
 * before anything is sent. The host re-checks approval; this panel does not
 * call a destination itself.
 */
export function CanvasExportPanel(props: CanvasExportPanelProps) {
  const ready = props.offers.targets.filter((target) => target.status === "ready");
  const [targetId, setTargetId] = useState(ready[0]?.targetId ?? "");
  const selected = props.offers.targets.find((target) => String(target.targetId) === targetId);
  const formats = selected?.formats ?? [];
  const [format, setFormat] = useState(formats[0] ?? "markdown");
  const [card, setCard] = useState<CanvasExportApprovalCard | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const chosenFormat = formats.includes(format) ? format : formats[0];

  async function prepare() {
    if (selected === undefined || selected.status !== "ready" || chosenFormat === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await props.onPrepare({
        schemaVersion: 1,
        kind: "canvas-export-prepare",
        canvasId: props.offers.canvasId,
        versionId: props.offers.versionId,
        expectedSequence: props.offers.sequence,
        targetId: selected.targetId,
        format: chosenFormat,
      });
      if (result.kind === "approval") {
        setCard(result.card);
        return;
      }
      setMessage(result.message);
    } catch {
      setMessage("Export could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: CanvasExportDecideRequest["decision"]) {
    if (card === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await props.onDecide({
        schemaVersion: 1,
        kind: "canvas-export-decision",
        canvasId: props.offers.canvasId,
        approvalId: card.approvalId,
        decision,
      });
      setCard(undefined);
      if (result.kind === "exported") {
        setMessage(receiptText(result.record.outcome));
        return;
      }
      setMessage(result.message);
    } catch {
      setMessage("Export could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="canvas-export" data-testid="canvas-export-panel">
      <h2 className="canvas-export__title" id="canvas-export-title">
        Export
      </h2>
      <p className="canvas-export__description" id="canvas-export-description">
        Send a rendered copy to a destination. Nothing leaves until you approve the payload and the
        destination.
      </p>
      {props.offers.targets.length === 0 ? (
        <p className="canvas-export__note" data-testid="canvas-export-empty">
          No destination is ready.
        </p>
      ) : card === undefined ? (
        <form
          className="canvas-export__form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void prepare();
          }}
        >
          <OctantSelectField
            aria-label="Destination"
            id="canvas-export-destination"
            onValueChange={setTargetId}
            options={props.offers.targets.map((target) => ({
              id: String(target.targetId),
              label: destinationLabel(target),
              disabled: target.status !== "ready",
              ...(target.message === undefined ? {} : { disabledReason: target.message }),
            }))}
            value={targetId}
          />
          <ul className="canvas-export__statuses">
            {props.offers.targets.map((target) => (
              <li key={String(target.targetId)}>
                <span>{target.label}</span>
                <span>{STATUS_LABEL[target.status]}</span>
                {target.message === undefined ? null : <span>{target.message}</span>}
              </li>
            ))}
          </ul>
          <OctantSelectField
            aria-label="Format"
            id="canvas-export-format"
            onValueChange={(value) => {
              if (value === "markdown" || value === "html") setFormat(value);
            }}
            options={(formats.length === 0 ? (["markdown", "html"] as const) : formats).map(
              (item) => ({
                id: item,
                label: item === "markdown" ? "Markdown" : "HTML",
              }),
            )}
            value={chosenFormat ?? "markdown"}
          />
          <OctantButton
            disabled={busy || selected?.status !== "ready" || chosenFormat === undefined}
            type="submit"
            variant="secondary"
          >
            {busy ? "Preparing…" : "Review export"}
          </OctantButton>
        </form>
      ) : (
        <OctantApprovalCard
          actions={
            <>
              <OctantButton
                disabled={busy}
                onClick={() => void decide("denied")}
                type="button"
                variant="ghost"
              >
                Don't export
              </OctantButton>
              <OctantButton
                disabled={busy}
                onClick={() => void decide("approved")}
                type="button"
                variant="secondary"
              >
                {busy ? "Exporting…" : "Approve export"}
              </OctantButton>
            </>
          }
          detail={card.format === "markdown" ? "Markdown" : "HTML"}
          label="Approve export"
          summary={`Export to ${card.destinationLabel}`}
        >
          <pre className="canvas-export__payload" data-testid="canvas-export-payload">
            {card.payload}
          </pre>
        </OctantApprovalCard>
      )}
      {message === undefined ? null : (
        <p className="canvas-export__note" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

function destinationLabel(target: CanvasExportTargetOffer): string {
  return `${target.label} — ${STATUS_LABEL[target.status]}`;
}

function receiptText(outcome: CanvasExportDelivery): string {
  if (outcome.kind === "refused") return outcome.message;
  const receipt = outcome.receipt;
  if (receipt.kind === "link") return `Exported. ${receipt.href}`;
  if (receipt.kind === "path") return `Exported. ${receipt.path}`;
  return `Exported. ${receipt.remoteId}`;
}
