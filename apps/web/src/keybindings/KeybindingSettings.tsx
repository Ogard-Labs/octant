import {
  OCTANT_KEYBINDING_ACTIONS,
  chordFromEvent,
  describeChord,
  formatChord,
  parseChord,
  type OctantKeybindingActionId,
} from "@octant/domain";
import { useState, type KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import { isApplePlatform } from "../platform";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { useKeybindings, type KeybindingController } from "./useKeybindings";

export interface KeybindingSettingsProps {
  /** Injected in tests; otherwise the app's own store. */
  readonly controller?: KeybindingController;
}

/**
 * Change which chord reaches which surface.
 *
 * Two ways in, because they answer different questions: pressing the keys is
 * how you find out whether a chord is comfortable, and the JSON is how you move
 * a set of them between machines. Both write the same document, and the list
 * always shows what is actually in effect — including a chord that two actions
 * ended up sharing, which is otherwise only discoverable by pressing it.
 */
export function KeybindingSettings(props: KeybindingSettingsProps) {
  const fallback = useKeybindings();
  const controller = props.controller ?? fallback;
  const apple = isApplePlatform();
  const [recording, setRecording] = useState<OctantKeybindingActionId>();
  const [recordError, setRecordError] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const [draftError, setDraftError] = useState<string>();

  const shadowed = new Set(
    controller.keybindings.conflicts.flatMap((conflict) => conflict.actionIds.slice(1)),
  );

  function record(actionId: OctantKeybindingActionId, event: KeyboardEvent<HTMLButtonElement>) {
    // Modifier keys arrive on their own while the chord is still being held;
    // waiting for a real key is what lets the user press Cmd then Shift then P.
    if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
    event.preventDefault();
    // While recording, the chord is being named, not used. Without this it also
    // reaches the window-level listeners, so pressing a chord that is already
    // assigned runs its action — Zen mode hiding Settings mid-recording, say.
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(undefined);
      setRecordError(undefined);
      return;
    }
    const candidate = formatChord(chordFromEvent(event, apple));
    const parsed = parseChord(candidate);
    if (parsed.status !== "ok") {
      setRecordError(parsed.reason);
      return;
    }
    controller.bind(actionId, candidate);
    setRecording(undefined);
    setRecordError(undefined);
  }

  return (
    <div className="keybinding-settings">
      <ul className="keybinding-settings__list">
        {OCTANT_KEYBINDING_ACTIONS.map((action) => {
          const chord = controller.keybindings.bindings.get(action.id);
          const bound = chord === undefined ? "Unbound" : describeChord(chord, apple);
          const custom = chord !== undefined && formatChord(chord) !== action.defaultChord;
          return (
            <li key={action.id}>
              <span className="keybinding-settings__action">
                <span>{action.label}</span>
                <span className="keybinding-settings__area">{action.area}</span>
              </span>
              <OctantButton
                aria-label={`Change the chord for ${action.label}`}
                onClick={() => {
                  setRecordError(undefined);
                  setRecording(recording === action.id ? undefined : action.id);
                }}
                onKeyDown={(event) => {
                  if (recording === action.id) record(action.id, event);
                }}
                size="sm"
                variant={recording === action.id ? "secondary" : "ghost"}
              >
                {recording === action.id ? "Press a chord…" : bound}
              </OctantButton>
              {custom ? (
                <OctantButton
                  aria-label={`Reset ${action.label} to its default chord`}
                  onClick={() => controller.reset(action.id)}
                  size="sm"
                  variant="ghost"
                >
                  Reset
                </OctantButton>
              ) : null}
              {shadowed.has(action.id) ? (
                <span className="keybinding-settings__warning" role="note">
                  Shares {bound} with another action and will not run.
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {recordError === undefined ? null : <p role="alert">{recordError}</p>}
      {controller.keybindings.rejected.map((rejection) => (
        <p key={`${rejection.actionId}-${rejection.chord}`} role="alert">
          {rejection.actionId}: {rejection.reason} Using the default instead.
        </p>
      ))}
      {controller.documentError === undefined ? null : (
        <p role="alert">
          Saved keybindings could not be read: {controller.documentError} Every action is on its
          default.
        </p>
      )}
      <details className="settings-disclosure keybinding-settings__advanced">
        <summary>
          <ChevronRight aria-hidden="true" size={12} />
          <span>Edit keybindings JSON</span>
        </summary>
        <div className="keybinding-settings__advanced-body">
          <label className="keybinding-settings__json">
            Keybindings JSON
            <OctantTextarea
              onChange={(event) => setDraft(event.target.value)}
              rows={8}
              value={draft ?? controller.document}
            />
          </label>
          <div className="keybinding-settings__actions">
            <OctantButton
              disabled={draft === undefined}
              onClick={() => {
                if (draft === undefined) return;
                const failure = controller.saveDocument(draft);
                setDraftError(failure);
                if (failure === undefined) setDraft(undefined);
              }}
              size="sm"
              variant="secondary"
            >
              Save JSON
            </OctantButton>
            <OctantButton
              onClick={() => {
                controller.resetAll();
                setDraft(undefined);
                setDraftError(undefined);
              }}
              size="sm"
              variant="ghost"
            >
              Reset all to defaults
            </OctantButton>
          </div>
          {draftError === undefined ? null : <p role="alert">{draftError}</p>}
        </div>
      </details>
    </div>
  );
}
