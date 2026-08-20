import { Sparkles } from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  ROUTINE_REQUEST_SUGGESTIONS,
  draftRoutineFromRequest,
  type RoutineRequestDraft,
} from "./routineRequestDraft";
import { routineScheduleLabel } from "./routinePresentation";

export interface RoutineComposerProps {
  readonly now: string;
  readonly timeZone: string;
  /** Hands the confirmed draft to whoever opens the editor with it filled in. */
  readonly onConfirm: (draft: RoutineRequestDraft) => void;
}

/**
 * Asking for a routine in your own words.
 *
 * The composer never creates anything. It reads the request, shows what it
 * understood, and waits: a schedule the host would act on unattended is not
 * something to infer from a sentence and then run. When it cannot read a
 * schedule it says so and still carries the work forward, so the person fills
 * in the one part that was missing rather than retyping the request.
 */
export function RoutineComposer(props: RoutineComposerProps) {
  const [request, setRequest] = useState("");
  const [draft, setDraft] = useState<RoutineRequestDraft>();

  const read = (text: string) => {
    setRequest(text);
    setDraft(
      text.trim().length === 0
        ? undefined
        : draftRoutineFromRequest(text, { now: props.now, timeZone: props.timeZone }),
    );
  };

  return (
    <section aria-label="Describe a routine" className="routine-composer">
      <label className="routine-composer__label" htmlFor="routine-composer-request">
        <Sparkles aria-hidden="true" size={13} strokeWidth={1.8} />
        What do you want automated?
      </label>
      <textarea
        className="routine-composer__input textarea"
        id="routine-composer-request"
        onChange={(event) => read(event.target.value)}
        placeholder="Every weekday at 9:00, summarise what changed overnight"
        rows={2}
        value={request}
      />

      <ul aria-label="Routine suggestions" className="routine-composer__suggestions">
        {ROUTINE_REQUEST_SUGGESTIONS.map((suggestion) => (
          <li key={suggestion.label}>
            <button
              className="routine-composer__chip"
              onClick={() => read(suggestion.request)}
              type="button"
            >
              {suggestion.label}
            </button>
          </li>
        ))}
      </ul>

      {draft === undefined ? null : (
        <div className="routine-composer__draft" role="status">
          <p className="routine-composer__draft-schedule">
            {draft.trigger === undefined
              ? draft.scheduleSummary
              : routineScheduleLabel(draft.trigger, { timeZone: props.timeZone })}
          </p>
          <p className="routine-composer__draft-work">{draft.prompt}</p>
          <OctantButton
            onClick={() => props.onConfirm(draft)}
            size="sm"
            type="button"
            variant="secondary"
          >
            {draft.needsSchedule ? "Review and add a schedule" : "Review this routine"}
          </OctantButton>
        </div>
      )}
    </section>
  );
}
