import type {
  FinishedReceiptCheckStatus,
  FinishedReceiptItem,
  ThreadFinishedReceipt,
} from "@octant/contracts";
import { useId, useState } from "react";
import { Check, CheckCircle2, ChevronDown, CircleAlert, Clock, Minus, X } from "../ui/icons";
import { OctantButton } from "../ui/base/OctantButton";
import { useThreadFinishedReceipts } from "./FinishedReceiptProvider";
import "./finished-receipt.css";

export interface FinishedReceiptPlacement {
  readonly turnId: string | undefined;
  readonly loadedTurnIds: ReadonlySet<string>;
  readonly last: boolean;
}

/**
 * Selects the finished receipts that belong at the end of one turn. A receipt
 * with a `turnId` renders after that turn; if its turn is not among the loaded
 * page (or it has no `turnId`), it renders at the end of the latest turn.
 */
export function finishedReceiptsAfterTurn(
  receipts: ReadonlyArray<ThreadFinishedReceipt>,
  placement: FinishedReceiptPlacement,
): ReadonlyArray<ThreadFinishedReceipt> {
  return receipts.filter((entry) => {
    const receiptTurn = entry.receipt.turnId;
    if (receiptTurn !== undefined && placement.turnId === receiptTurn) return true;
    if (!placement.last) return false;
    return receiptTurn === undefined || !placement.loadedTurnIds.has(receiptTurn);
  });
}

/** Renders any finished-with-proof receipts belonging to the end of a turn. */
export function FinishedReceiptInline(props: FinishedReceiptPlacement) {
  const receipts = useThreadFinishedReceipts();
  const placed = finishedReceiptsAfterTurn(receipts, props);
  if (placed.length === 0) return null;
  return (
    <>
      {placed.map((entry) => (
        <FinishedReceiptCard key={String(entry.receipt.receiptId)} receipt={entry} />
      ))}
    </>
  );
}

const ITEM_STATUS_LABEL: Readonly<Record<FinishedReceiptCheckStatus, string>> = {
  proven: "Proven",
  failed: "Failed",
  claimed: "Claimed",
  unavailable: "Unavailable",
};

function ItemStatusIcon(props: { readonly status: FinishedReceiptCheckStatus }) {
  switch (props.status) {
    case "proven":
      return <Check aria-hidden="true" size={12} />;
    case "failed":
      return <X aria-hidden="true" size={12} />;
    case "claimed":
      return <Clock aria-hidden="true" size={12} />;
    case "unavailable":
      return <Minus aria-hidden="true" size={12} />;
  }
}

function FinishedReceiptItemRow(props: { readonly item: FinishedReceiptItem }) {
  const [expanded, setExpanded] = useState(false);
  const outputId = useId();
  const { item } = props;
  const hasOutput = item.outputTail !== undefined && item.outputTail.length > 0;

  return (
    <li className="finished-receipt__item">
      <div className="finished-receipt__item-row">
        <span className="finished-receipt__item-status" data-status={item.status}>
          <ItemStatusIcon status={item.status} />
          <span>{ITEM_STATUS_LABEL[item.status]}</span>
        </span>
        <span className="finished-receipt__item-label" data-kind={item.kind}>
          {item.label}
          {item.kind === "goal-criterion" && item.command !== undefined ? (
            <span className="finished-receipt__item-command">{item.command}</span>
          ) : null}
        </span>
        {hasOutput ? (
          <OctantButton
            aria-controls={outputId}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <span>{expanded ? "Hide output" : "Output"}</span>
            <ChevronDown aria-hidden="true" data-open={expanded} size={12} />
          </OctantButton>
        ) : null}
      </div>
      {item.reason === undefined ? null : (
        <p className="finished-receipt__item-reason">{item.reason}</p>
      )}
      {hasOutput && expanded ? (
        <pre className="finished-receipt__output" id={outputId}>
          {item.outputTail}
        </pre>
      ) : null}
    </li>
  );
}

/**
 * The "Finished, with proof" card shown at the end of a Work or Code turn and
 * above the last reply on the Review page. Displays the summary, each host-run
 * check or goal criterion with its status and expandable output, the observed
 * diff counts (or unavailable), and stale status when later file changes landed.
 */
export function FinishedReceiptCard(props: { readonly receipt: ThreadFinishedReceipt }) {
  const { receipt } = props;
  const { summary, items, diff } = receipt.receipt;

  const badge = receipt.stale
    ? { tone: "stale", text: "Stale" }
    : receipt.provenCount > 0
      ? {
          tone: "proven",
          text:
            receipt.claimedCount > 0
              ? `${String(receipt.provenCount)} proven · ${String(receipt.claimedCount)} claimed`
              : `${String(receipt.provenCount)} proven`,
        }
      : receipt.status === "unavailable"
        ? { tone: "neutral", text: "Unavailable" }
        : { tone: "neutral", text: "Claimed" };

  return (
    <section
      aria-label="Finished, with proof"
      className="finished-receipt"
      data-stale={receipt.stale ? "true" : "false"}
      data-status={receipt.status}
    >
      <header className="finished-receipt__head">
        <div className="finished-receipt__title-group">
          {receipt.stale ? (
            <CircleAlert aria-hidden="true" size={14} />
          ) : (
            <CheckCircle2 aria-hidden="true" size={14} />
          )}
          <h3 className="finished-receipt__title">Finished, with proof</h3>
          <span className="finished-receipt__badge" data-tone={badge.tone}>
            {badge.text}
          </span>
        </div>
        <span
          className="finished-receipt__diff"
          title={diff.status === "unavailable" ? diff.reason : undefined}
        >
          {diff.status === "observed" ? (
            <>
              <span>
                {diff.changedFiles === 1
                  ? "1 file"
                  : `${diff.changedFiles.toLocaleString("en")} files`}
              </span>
              <span className="finished-receipt__added">
                {`+${diff.insertions.toLocaleString("en")}`}
              </span>
              <span className="finished-receipt__removed">
                {`−${diff.deletions.toLocaleString("en")}`}
              </span>
            </>
          ) : (
            <span>Diff unavailable</span>
          )}
        </span>
      </header>
      {receipt.stale ? (
        <p className="finished-receipt__stale" role="status">
          Stale — files changed after this report was recorded.
        </p>
      ) : null}
      <p className="finished-receipt__summary">{summary}</p>
      {items.length === 0 ? null : (
        <ul aria-label="Proof checks" className="finished-receipt__items">
          {items.map((item, index) => (
            <FinishedReceiptItemRow
              item={item}
              key={`${item.kind}-${item.criterionId ?? item.command ?? String(index)}`}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
