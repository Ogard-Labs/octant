import { Check, GitBranch, LoaderCircle } from "lucide-react";
import { ProviderGlyph } from "../providers/ProviderGlyph";

/**
 * The mark at the head of a status column. Ready is a hollow ring (nothing has
 * started), In Progress turns while a card in the column is actually executing
 * and is a filled dot when none is, Waiting is a filled dot, and Done is a
 * check. The shapes differ so the default theme needs no hue to tell the
 * columns apart; the Vivid style tints them from the same hooks.
 */
export function ThreadBoardStatusMark(props: {
  readonly status: string;
  readonly executing: boolean;
}) {
  const turning = props.status === "in-progress" && props.executing;
  return (
    <span
      aria-hidden="true"
      className="board-status-mark"
      data-executing={turning ? "true" : "false"}
      data-status={props.status}
    >
      {turning ? (
        <LoaderCircle className="board-status-mark__spin" size={12} strokeWidth={2} />
      ) : props.status === "done" ? (
        <Check size={12} strokeWidth={2} />
      ) : (
        <span
          className="board-status-mark__dot"
          data-fill={props.status === "ready" ? "hollow" : "solid"}
        />
      )}
    </span>
  );
}

export interface ThreadBoardCardMetaProps {
  /** The provider that runs the thread; the glyph is decoration, the name is read aloud. */
  readonly provider?: { readonly label: string; readonly driverKind: string };
  readonly branch?: string;
  readonly diff?: { readonly insertions: number; readonly deletions: number };
  readonly age?: { readonly label: string; readonly title: string };
}

/**
 * The footer of a card: who runs it, where it is checked out, how much it
 * changed, and when it last moved. Each part is optional and the row renders
 * nothing when none is known, so a card never carries an empty strip.
 */
export function ThreadBoardCardMeta(props: ThreadBoardCardMetaProps) {
  if (
    props.provider === undefined &&
    props.branch === undefined &&
    props.diff === undefined &&
    props.age === undefined
  ) {
    return null;
  }
  return (
    <span className="board-card-meta">
      {props.provider === undefined ? null : (
        <span className="board-card-meta__provider" title={props.provider.label}>
          <ProviderGlyph
            displayName={props.provider.label}
            driverKind={props.provider.driverKind}
            size={16}
          />
          <span className="sr-only">{props.provider.label}</span>
        </span>
      )}
      {props.branch === undefined ? null : (
        <span className="board-card-meta__branch" title={props.branch}>
          <GitBranch aria-hidden="true" className="icon" size={12} strokeWidth={1.8} />
          <span className="board-card-meta__branch-name">{props.branch}</span>
        </span>
      )}
      {props.diff === undefined ? null : (
        <span className="board-card-meta__diff">
          <span className="board-card-meta__added">+{props.diff.insertions.toLocaleString()}</span>
          <span className="board-card-meta__removed">
            {"−"}
            {props.diff.deletions.toLocaleString()}
          </span>
        </span>
      )}
      {props.age === undefined ? null : (
        <span className="board-card-meta__age" title={props.age.title}>
          {props.age.label}
        </span>
      )}
    </span>
  );
}

/**
 * What an executing thread is doing right now, under its title: a turning mark
 * and the latest sub-agent line, or "Working…" when none has reported. Only an
 * executing card carries it; a card that is not running says nothing live.
 */
export function ThreadBoardCardLive(props: { readonly summary: string | undefined }) {
  return (
    <span className="board-card-live">
      <LoaderCircle
        aria-hidden="true"
        className="board-card-live__spin"
        size={12}
        strokeWidth={2}
      />
      <span className="board-card-live__text" title={props.summary}>
        {props.summary ?? "Working…"}
      </span>
    </span>
  );
}
