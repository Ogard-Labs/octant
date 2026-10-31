import type { AutomationSummary } from "@octant/contracts/automation";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";

const DEFAULT_FOLLOW_UP_PROMPT = "Check on this and summarise what has changed since.";

type QuickPick = "hour" | "tomorrow" | "custom";
export type Editing =
  | { readonly kind: "new" }
  | { readonly kind: "move"; readonly summary: AutomationSummary };

/**
 * The picker for a one-time follow-up in this thread: a later turn the host
 * sends here with a fixed prompt, so the agent picks the conversation back up
 * ("check whether the reply arrived"). The Routines row opens it to set one
 * up or to move a pending one.
 */
export function FollowUpPicker(props: {
  readonly editing: Editing;
  readonly busy: boolean;
  readonly onSubmit: (scheduledAt: string, taskPrompt: string) => void;
  readonly onClose: () => void;
}) {
  const ids = { custom: useId(), prompt: useId() };
  const [pick, setPick] = useState<QuickPick>("tomorrow");
  const [custom, setCustom] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_FOLLOW_UP_PROMPT);
  const moving = props.editing.kind === "move";
  const scheduledAt = quickPickInstant(pick, custom, new Date());
  const ready = scheduledAt !== undefined && (moving || prompt.trim().length > 0);
  const choices: ReadonlyArray<{ readonly value: QuickPick; readonly label: string }> = [
    { value: "hour", label: "In 1 hour" },
    { value: "tomorrow", label: "Tomorrow at 9:00" },
    { value: "custom", label: "Pick a time" },
  ];
  return (
    <form
      aria-label={moving ? "Change follow-up time" : "Follow up later"}
      className="environment-follow-up-picker"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) props.onSubmit(scheduledAt, prompt.trim());
      }}
    >
      <div className="environment-follow-up-picker__picks" role="group" aria-label="When">
        {choices.map((choice) => (
          <OctantButton
            aria-pressed={pick === choice.value}
            className="window-no-drag"
            key={choice.value}
            onClick={() => setPick(choice.value)}
            size="sm"
            type="button"
            variant={pick === choice.value ? "secondary" : "ghost"}
          >
            {choice.label}
          </OctantButton>
        ))}
      </div>
      {pick === "custom" ? (
        <div className="environment-follow-up-picker__field">
          <label htmlFor={ids.custom}>Follow up at</label>
          <OctantInput
            className="input"
            id={ids.custom}
            onChange={(event) => setCustom(event.target.value)}
            type="datetime-local"
            value={custom}
          />
        </div>
      ) : null}
      {moving ? null : (
        <div className="environment-follow-up-picker__field">
          <label htmlFor={ids.prompt}>What to check</label>
          <OctantTextarea
            id={ids.prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={2}
            value={prompt}
          />
        </div>
      )}
      <p className="environment-follow-up-picker__note">
        It runs once in this thread with the thread&apos;s own access, asking before effects. It is
        skipped if the thread is busy, done, or archived by then.
      </p>
      <div className="environment-routine__actions">
        <OctantButton
          className="window-no-drag"
          disabled={!ready || props.busy}
          size="sm"
          type="submit"
        >
          {moving ? "Move follow-up" : "Schedule follow-up"}
        </OctantButton>
        <OctantButton
          className="window-no-drag"
          onClick={props.onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          Close
        </OctantButton>
      </div>
    </form>
  );
}

/** The instant a quick pick names, or undefined when it names none in the future. */
function quickPickInstant(pick: QuickPick, custom: string, now: Date): string | undefined {
  if (pick === "hour") {
    const at = new Date(now.getTime() + 60 * 60_000);
    at.setSeconds(0, 0);
    return at.toISOString();
  }
  if (pick === "tomorrow") {
    const at = new Date(now);
    at.setDate(at.getDate() + 1);
    at.setHours(9, 0, 0, 0);
    return at.toISOString();
  }
  // A datetime-local value has no zone; the browser reads it as local time.
  const ms = custom === "" ? Number.NaN : new Date(custom).getTime();
  return Number.isFinite(ms) && ms > now.getTime() ? new Date(ms).toISOString() : undefined;
}

/** A pending follow-up is due at its once trigger's instant. */
export function scheduledAtOf(summary: AutomationSummary): string {
  return summary.trigger.kind === "once" ? summary.trigger.scheduledAt : (summary.nextDueAt ?? "");
}
