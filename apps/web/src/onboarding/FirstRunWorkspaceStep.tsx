import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type { WorkspaceChoices } from "./firstRunStepModel";

export interface FirstRunWorkspaceStepProps {
  readonly choices: WorkspaceChoices;
  readonly onSelectColorScheme: (scheme: "system" | "light" | "dark") => void;
  readonly onToggleChat: (enabled: boolean) => void;
  readonly onToggleWork: (enabled: boolean) => void;
  readonly onSelectModeSwitcher: (presentation: "buttons" | "dropdown") => void;
}

const SCHEMES = [
  { value: "system", label: "System" },
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
        Choose the defaults you want to see on first launch. They remain available in Settings.
      </p>

      <div aria-label="Workspace defaults" className="setgroup" role="group">
        <div className="setgroup-head">Workspace defaults</div>
        <div className="setrow">
          <span className="setrow-label">Colour scheme</span>
          <div className="setrow-control">
            {schemeUnknown ? (
              <span className="first-run__loading-value" role="status">
                Loading…
              </span>
            ) : (
              <OctantToggleGroup<NonNullable<WorkspaceChoices["colorScheme"]>>
                aria-label="Colour scheme"
                onValueChange={(value) => {
                  const selected = value[0];
                  if (selected !== undefined) props.onSelectColorScheme(selected);
                }}
                role="radiogroup"
                value={[choices.colorScheme]}
              >
                {SCHEMES.map((scheme) => (
                  <OctantToggleGroupItem
                    aria-checked={choices.colorScheme === scheme.value}
                    key={scheme.value}
                    role="radio"
                    value={scheme.value}
                  >
                    {scheme.label}
                  </OctantToggleGroupItem>
                ))}
              </OctantToggleGroup>
            )}
          </div>
        </div>
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
        <p className="first-run__caveat" role="note">
          Code is always available. Hiding Chat or Work never deletes its threads or data.
        </p>
      </div>
    </div>
  );
}
