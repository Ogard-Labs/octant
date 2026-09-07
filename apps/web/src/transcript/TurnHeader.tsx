import { Ban, Check, Circle, CircleAlert, CircleX, Clock3, LoaderCircle } from "lucide-react";

/**
 * The state a turn can be read in, across Chat, Work, and Code. Each mode maps
 * its own lifecycle onto these words so a person learns one vocabulary.
 */
export type TurnHeaderOutcome =
  | "queued"
  | "streaming"
  | "running"
  | "waiting"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "completed";

export interface TurnHeaderProps {
  readonly outcome: TurnHeaderOutcome;
  /** Who produced the turn, as the model picker names it. */
  readonly provider?: string;
  /** Overrides the outcome's default word, e.g. "Waiting for approval". */
  readonly label?: string;
  /** "Worked for 6s"; only a finished turn has one. */
  readonly workedFor?: string;
  /** When the turn last changed, ISO 8601. */
  readonly at?: string;
  /** Why the turn failed, stopped, or waits, in the sanitized words the host gives. */
  readonly reason?: string;
}

const OUTCOME_LABELS: Record<TurnHeaderOutcome, string> = {
  queued: "Queued",
  streaming: "Streaming",
  running: "Working…",
  // Keep the slot filled while paused on approval so the transcript does not
  // jump when an elapsed indicator would otherwise drop.
  waiting: "Waiting for approval",
  interrupted: "Interrupted",
  failed: "Failed",
  cancelled: "Cancelled",
  completed: "Completed",
};

const LIVE_OUTCOMES = new Set<TurnHeaderOutcome>(["queued", "streaming", "running"]);

function outcomeIcon(outcome: TurnHeaderOutcome) {
  switch (outcome) {
    case "queued":
      return Circle;
    case "streaming":
    case "running":
      return LoaderCircle;
    case "waiting":
      return Clock3;
    case "interrupted":
      return CircleAlert;
    case "failed":
      return CircleX;
    case "cancelled":
      return Ban;
    case "completed":
      return Check;
  }
}

/**
 * One line above every assistant reply: who answered, how the turn ended, and
 * when. Before this each mode drew its own — Chat a mono status under the
 * reply, Work the raw lifecycle word, Code a header of its own — so the same
 * outcome looked like three different things.
 */
export function TurnHeader(props: TurnHeaderProps) {
  const Icon = outcomeIcon(props.outcome);
  const time = turnTimeLabel(props.at);
  return (
    <>
      <header className="turn-header" data-outcome={props.outcome}>
        {props.provider === undefined ? null : (
          <span className="turn-header__provider">{props.provider}</span>
        )}
        <span
          className="turn-header__status"
          // Only a turn still in flight, or paused on the person, is a live
          // region; a finished outcome is static text, not an announcement.
          {...(LIVE_OUTCOMES.has(props.outcome) || props.outcome === "waiting"
            ? { "aria-live": "polite" as const, role: "status" }
            : {})}
        >
          <Icon aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{props.label ?? OUTCOME_LABELS[props.outcome]}</span>
          {props.workedFor === undefined ? null : (
            <span className="turn-header__worked-for">{props.workedFor}</span>
          )}
        </span>
        {time === undefined || props.at === undefined ? null : (
          <time
            className="turn-header__time turn-time"
            dateTime={props.at}
            title={turnTimeTitle(props.at)}
          >
            {time}
          </time>
        )}
      </header>
      {/* Static text on purpose: the transcript window remounts historical rows
          as the visible range moves, and a live role would re-announce an old
          failure every time its row scrolled back in. */}
      {props.reason === undefined ? null : <p className="turn-header__reason">{props.reason}</p>}
    </>
  );
}

/**
 * When a person's message was sent, under its bubble on the same edge: the
 * one time treatment the turn header also uses at its end. Renders nothing
 * for a timestamp the host did not give in a form a clock can read.
 */
export function TurnTime(props: { readonly at: string }) {
  const label = turnTimeLabel(props.at);
  if (label === undefined) return null;
  return (
    <time className="turn-time" dateTime={props.at} title={turnTimeTitle(props.at)}>
      {label}
    </time>
  );
}

/**
 * How long a finished turn took, from when it was created to its last change.
 * Only a completed turn reports it: for any other outcome the last change is
 * whatever ended it, which is not the same as time spent working.
 */
export function turnWorkedFor(
  outcome: TurnHeaderOutcome,
  createdAt: string,
  updatedAt: string,
): string | undefined {
  if (outcome !== "completed") return undefined;
  const started = Date.parse(createdAt);
  const ended = Date.parse(updatedAt);
  if (Number.isNaN(started) || Number.isNaN(ended)) return undefined;
  const seconds = Math.floor((ended - started) / 1000);
  if (seconds < 1) return undefined;
  if (seconds < 60) return `Worked for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `Worked for ${minutes}m ${seconds % 60}s`;
}

/** Clock time for today, date and time for anything older. */
export function turnTimeLabel(at: string | undefined): string | undefined {
  if (at === undefined) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function turnTimeTitle(at: string | undefined): string | undefined {
  if (at === undefined) return undefined;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}
