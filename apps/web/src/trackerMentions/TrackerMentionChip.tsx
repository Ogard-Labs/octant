import type { TrackerMention } from "@octant/contracts";
import { findTrackerMentionSpans, trackerMentionLabel } from "@octant/domain";
import { useContext, useState } from "react";
import type { ComposerInputElement } from "../composer/ComposerInput";
import { openExternalUrl } from "../shell/openExternalUrl";
import { ThreadReferencesContext } from "../threadReferences/ThreadReferences";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { mentionedPullRequestIdentity } from "./mentionedPullRequestIdentity";
import { trackerMentionFacts } from "./trackerMentionFacts";
import {
  TRACKER_MENTION_KIND_LABEL,
  TrackerMentionIcon,
  trackerMentionContainer,
  trackerMentionStateText,
} from "./trackerMentionPresentation";
import "../composer/composer-chip.css";
import "./tracker-mention.css";

export interface TrackerMentionChipProps {
  readonly mention: TrackerMention;
  /** The title as the text around the chip writes it. */
  readonly title: string;
  /** Present in a composer, where the chip and its text can be taken back. */
  readonly composer?: {
    readonly draft: string;
    readonly onDraftChange: (draft: string, caretIndex: number) => void;
    readonly textarea: () => ComposerInputElement | null;
  };
}

/**
 * Takes every reference to one item out of a draft, with the space a chip was
 * written with where leaving it would leave two, or one at the start.
 */
function withoutReference(draft: string, url: string) {
  let next = draft;
  let caretIndex = draft.length;
  for (const span of findTrackerMentionSpans(draft).toReversed()) {
    if (span.mention.url !== url) continue;
    const opensWithSpace = span.start === 0 || /\s/.test(next[span.start - 1] ?? "");
    const end = opensWithSpace && next[span.end] === " " ? span.end + 1 : span.end;
    next = `${next.slice(0, span.start)}${next.slice(end)}`;
    caretIndex = span.start;
  }
  return { draft: next, caretIndex };
}

/**
 * A pull request or issue named in text: one chip with its card. The card's
 * facts are what a `#` search in this window already said of the item, so
 * opening it asks no tracker anything.
 */
export function TrackerMentionChip(props: TrackerMentionChipProps) {
  const { mention } = props;
  const [open, setOpen] = useState(false);
  const references = useContext(ThreadReferencesContext);
  const facts = trackerMentionFacts(mention.url);
  const label = trackerMentionLabel(mention);
  const kind = TRACKER_MENTION_KIND_LABEL[mention.kind];
  const title = facts?.title ?? props.title;
  const state = facts === undefined ? undefined : trackerMentionStateText(facts.state);
  const linear = mention.source === "linear";
  // A pull request of a Project this window holds opens in Octant's pane.
  function openItem() {
    const identity = mentionedPullRequestIdentity(mention.url, references?.projects ?? []);
    const openPullRequest = references?.onOpenPullRequest;
    if (identity !== undefined && openPullRequest !== undefined) openPullRequest(identity);
    else openExternalUrl(references?.externalHost, mention.url);
  }
  const composer = props.composer;
  function remove() {
    if (composer === undefined) return;
    const next = withoutReference(composer.draft, mention.url);
    composer.onDraftChange(next.draft, next.caretIndex);
    queueMicrotask(() => {
      const element = composer.textarea();
      if (element === null) return;
      element.focus();
      element.setSelectionRange(next.caretIndex, next.caretIndex);
    });
  }
  const rows: ReadonlyArray<readonly [string, string]> = [
    ...(state === undefined ? [] : [["State", state] as const]),
    [linear ? "Team" : "Repository", facts?.container ?? trackerMentionContainer(mention)],
    ...(facts?.person === undefined
      ? []
      : [[linear ? "Assignee" : "Author", facts.person] as const]),
  ];
  return (
    <OctantPopover
      className="tracker-mention-card"
      onOpenChange={setOpen}
      open={open}
      openOnHover
      side="top"
      sideOffset={8}
      title={`${kind} details`}
      trigger={
        <>
          <TrackerMentionIcon kind={mention.kind} />
          <span className="composer-chip__text">{`${label} ${props.title}`}</span>
        </>
      }
      triggerClassName="composer-chip__button tracker-mention"
      triggerLabel={[`${kind} ${label}: ${title}`, state].filter(Boolean).join(", ")}
    >
      <p className="tracker-mention-card__kind">
        <TrackerMentionIcon kind={mention.kind} />
        <span>{`${kind} ${label}`}</span>
      </p>
      <p className="tracker-mention-card__title">{title}</p>
      <dl className="tracker-mention-card__facts">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="tracker-mention-card__actions">
        <OctantButton
          onClick={() => {
            setOpen(false);
            openItem();
          }}
          size="xs"
          type="button"
          variant="secondary"
        >
          Open
        </OctantButton>
        {composer === undefined ? null : (
          <OctantButton
            onClick={() => {
              setOpen(false);
              remove();
            }}
            size="xs"
            type="button"
            variant="secondary"
          >
            Remove
          </OctantButton>
        )}
      </div>
    </OctantPopover>
  );
}
