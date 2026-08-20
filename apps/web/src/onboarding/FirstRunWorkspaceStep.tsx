import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import type { WorkspaceChoices } from "./firstRunStepModel";

export interface FirstRunWorkspaceStepProps {
  readonly choices: WorkspaceChoices;
  readonly onSelectColorScheme: (scheme: "system" | "light" | "dark") => void;
  readonly onToggleChat: (enabled: boolean) => void;
  readonly onToggleWork: (enabled: boolean) => void;
  readonly onSelectModeSwitcher: (presentation: "buttons" | "dropdown") => void;
}

const SCHEMES = [
  { value: "system", label: "Match the system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/**
 * How the workspace looks, and which modes it offers.
 *
 * These are the choices a new user forms an opinion about within the first
 * minute and would otherwise have to go hunting for. Each writes through to
 * the same setting Settings owns, so nothing here is a first-run-only copy.
 *
 * Code is deliberately absent from the mode switches: it is always available,
 * and offering a switch that cannot be turned off would imply otherwise.
 * Turning Chat or Work off hides the mode; it never deletes anything, and the
 * step says so, because a switch labelled only "Enable Work" reads to a new
 * user like a choice about whether their work will exist.
 */
export function FirstRunWorkspaceStep(props: FirstRunWorkspaceStepProps) {
  const { choices } = props;
  const schemeUnknown = choices.colorScheme === undefined;

  return (
    <div className="first-run__step">
      <p className="first-run__intro">
        How Octant looks, and which modes appear in the sidebar. Every one of these can be changed
        later in Settings.
      </p>

      <div aria-label="Colour scheme" className="setgroup" role="group">
        <div className="setgroup-head">Colour scheme</div>
        {schemeUnknown ? (
          <p className="first-run__caveat" role="status">
            Octant is still loading its appearance settings, so it cannot say which scheme is in use
            yet.
          </p>
        ) : (
          <div aria-label="Colour scheme" className="first-run__choices" role="radiogroup">
            {SCHEMES.map((scheme) => (
              <button
                aria-checked={choices.colorScheme === scheme.value}
                className="first-run__choice"
                key={scheme.value}
                onClick={() => props.onSelectColorScheme(scheme.value)}
                role="radio"
                type="button"
              >
                {scheme.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div aria-label="Modes" className="setgroup" role="group">
        <div className="setgroup-head">Modes</div>
        <div className="setrow">
          <span className="setrow-label">Chat</span>
          <div className="setrow-control">
            <OctantSwitch
              checked={choices.chatEnabled}
              label="Enable Chat"
              onCheckedChange={props.onToggleChat}
            />
          </div>
        </div>
        <div className="setrow">
          <span className="setrow-label">Work</span>
          <div className="setrow-control">
            <OctantSwitch
              checked={choices.workEnabled}
              label="Enable Work"
              onCheckedChange={props.onToggleWork}
            />
          </div>
        </div>
        <p className="first-run__caveat" role="note">
          Code is always available. Turning Chat or Work off only hides the mode — its threads and
          data stay exactly where they are, and come back if you turn it on again.
        </p>
      </div>

      <div className="setgroup">
        <div className="setrow">
          <label className="setrow-label" htmlFor="first-run-mode-switcher">
            Mode switcher
          </label>
          <div className="setrow-control">
            <OctantNativeSelect
              aria-label="Mode switcher"
              id="first-run-mode-switcher"
              onChange={(event) =>
                props.onSelectModeSwitcher(event.currentTarget.value as "buttons" | "dropdown")
              }
              value={choices.modeSwitcher}
            >
              <option value="buttons">Compact buttons</option>
              <option value="dropdown">Dropdown</option>
            </OctantNativeSelect>
          </div>
        </div>
      </div>
    </div>
  );
}
