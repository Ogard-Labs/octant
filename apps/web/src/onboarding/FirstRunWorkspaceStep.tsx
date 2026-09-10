import { SettingRow } from "../settings/primitives";
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
 * the same setting Settings owns, so nothing here is a first-run-only copy —
 * including the row it is asked in, which is the `SettingRow` inside the
 * section object Settings draws.
 *
 * Code is deliberately absent from the mode switches: it is always available,
 * and offering a switch that cannot be turned off would imply otherwise.
 * Turning Chat or Work off hides the mode; it never deletes anything, and the
 * section's note says so, because a switch labelled only "Enable Work" reads
 * to a new user like a choice about whether their work will exist.
 */
export function FirstRunWorkspaceStep(props: FirstRunWorkspaceStepProps) {
  const { choices } = props;
  const schemeUnknown = choices.colorScheme === undefined;

  return (
    <div className="first-run__step">
      <p className="first-run__intro">
        Choose the defaults you want to see on first launch. They remain available in Settings.
      </p>

      <section
        aria-label="Workspace defaults"
        className="settings-card-section settings-card-section--open"
      >
        <h2>Workspace defaults</h2>
        {/* The guarantee belongs to the label, not below the rows: as a
            trailing paragraph it read as one more row of the group, which is
            the one thing it is not. */}
        <p className="settings-section-note" role="note">
          Code is always available. Hiding Chat or Work never deletes its threads or data.
        </p>
        <div className="setgroup">
          <SettingRow
            description="Follow this Mac, or hold Octant to light or dark."
            label="Colour scheme"
            scope="app"
            settingId="first-run-colour-scheme"
          >
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
          </SettingRow>
          <SettingRow
            description="Show Chat in the mode switcher."
            label="Chat"
            scope="app"
            settingId="first-run-enable-chat"
          >
            <OctantSwitch
              checked={choices.chatEnabled}
              describedBy="first-run-enable-chat-description"
              label="Enable Chat"
              onCheckedChange={props.onToggleChat}
            />
          </SettingRow>
          <SettingRow
            description="Show Work in the mode switcher."
            label="Work"
            scope="app"
            settingId="first-run-enable-work"
          >
            <OctantSwitch
              checked={choices.workEnabled}
              describedBy="first-run-enable-work-description"
              label="Enable Work"
              onCheckedChange={props.onToggleWork}
            />
          </SettingRow>
          <SettingRow
            description="How the sidebar offers Chat, Work, and Code."
            label="Mode switcher"
            scope="app"
            settingId="first-run-mode-switcher"
          >
            {/* The segmented control Settings asks this in. A dropdown made
                one question of four look like a different kind of question,
                and put a fourth control edge under the three above it. */}
            <OctantToggleGroup<WorkspaceChoices["modeSwitcher"]>
              aria-label="Mode switcher"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected !== undefined) props.onSelectModeSwitcher(selected);
              }}
              value={[choices.modeSwitcher]}
            >
              <OctantToggleGroupItem value="buttons">Buttons</OctantToggleGroupItem>
              <OctantToggleGroupItem value="dropdown">Dropdown</OctantToggleGroupItem>
            </OctantToggleGroup>
          </SettingRow>
        </div>
      </section>
    </div>
  );
}
