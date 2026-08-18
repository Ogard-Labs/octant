import type { ReactNode } from "react";
import type { ZenLiveCardFrozenReason } from "@octant/domain";
import type {
  ZenSourceContext,
  ZenThreadCatalogEntry,
  ZenThreadCatalogRef,
} from "@octant/contracts/zen";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * What an attached card is doing with its thread right now.
 *
 * Omitted means this card was never a live one — a mode the window does not
 * host in the focus zone, or a window with no thread surfaces to lend — and the
 * card stays the metadata reading it has always been. A live card renders the
 * surface the shell built for *this* card's source context; the focus zone lends it
 * nothing and cannot reach into it.
 */
export type ZenLiveThreadCard =
  | { readonly status: "streaming"; readonly surface: ReactNode }
  | { readonly status: "paused"; readonly reason: ZenLiveCardFrozenReason };

export interface ZenThreadElementProps {
  readonly entry?: ZenThreadCatalogEntry;
  readonly live?: ZenLiveThreadCard;
  readonly sourceContext: ZenSourceContext;
  readonly onContinue: (catalogRef: ZenThreadCatalogRef) => void;
}

export function ZenThreadElement(props: ZenThreadElementProps) {
  const entry = props.entry;
  if (entry === undefined) {
    return (
      <div className="zen-thread-element zen-thread-element--unavailable">
        <strong>Source unavailable</strong>
        <p>{`${capitalize(props.sourceContext.mode)} · ${props.sourceContext.projectId ?? "unfiled"}`}</p>
        <code>{String(props.sourceContext.threadId)}</code>
        <p>Octant kept the exact source identity and did not retarget by name.</p>
      </div>
    );
  }
  const live = props.live;
  const identity = (
    <p className="zen-thread-element__identity">
      {`${entry.hostLabel} · ${capitalize(entry.mode)} · ${entry.projectLabel}`}
    </p>
  );
  const continueButton = (
    <OctantButton
      aria-label={`Continue ${entry.title}`}
      onClick={() => props.onContinue(entry.catalogRef)}
      type="button"
      variant="secondary"
    >
      Continue
    </OctantButton>
  );
  if (live?.status === "streaming") {
    return (
      <div className="zen-thread-element zen-thread-element--live">
        {identity}
        <div className="zen-thread-element__surface">{live.surface}</div>
        {continueButton}
      </div>
    );
  }
  return (
    <div className="zen-thread-element">
      <strong>{entry.title}</strong>
      {identity}
      <p>{`${entry.status} · Updated ${entry.recentActivityAt}`}</p>
      <p>{`${entry.providerInstanceId} · ${entry.modelId}`}</p>
      {live === undefined ? null : (
        <p className="zen-thread-element__paused" role="status">
          {pausedExplanation(live.reason)}
        </p>
      )}
      {continueButton}
    </div>
  );
}

/**
 * Why the card is not streaming, in terms of what the reader can do about it.
 *
 * A paused card shows the reading it already had rather than a blank frame, so
 * the notice has to be explicit that this is not the live conversation.
 */
function pausedExplanation(reason: ZenLiveCardFrozenReason): string {
  switch (reason) {
    case "minimized":
      return "Paused while minimized. Restore the card to follow this thread again.";
    case "off-screen":
      return "Paused while out of view. Pan back to this card to follow the thread again.";
    case "budget":
      return "Paused while other cards are streaming. Select this card to follow it instead.";
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
