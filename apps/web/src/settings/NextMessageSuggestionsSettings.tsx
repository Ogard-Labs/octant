import type { NextMessageSuggestionsSetting } from "@octant/contracts/shell";
import type { OctantMode } from "@octant/contracts/modes";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow } from "./primitives";

const ALL_MODES: ReadonlyArray<OctantMode> = ["chat", "work", "code"];

const MODE_ROWS: ReadonlyArray<{
  readonly mode: OctantMode;
  readonly label: string;
  readonly settingId: string;
}> = [
  { mode: "chat", label: "In Chat", settingId: "next-message-suggestions-chat" },
  { mode: "work", label: "In Work", settingId: "next-message-suggestions-work" },
  { mode: "code", label: "In Code", settingId: "next-message-suggestions-code" },
];

export interface NextMessageSuggestionsSettingsProps {
  /** The stored setting; absent means on in every mode. */
  readonly value: NextMessageSuggestionsSetting | undefined;
  readonly onChange: (next: NextMessageSuggestionsSetting) => void;
  readonly focusedSetting: string | undefined;
}

/**
 * The switch for the composer's Tab suggestion and the modes it covers. The
 * mode rows keep their choice while the switch is off, so turning it back on
 * restores the modes the person had picked rather than resetting them.
 */
export function NextMessageSuggestionsSettings(props: NextMessageSuggestionsSettingsProps) {
  const setting = props.value ?? { enabled: true, modes: ALL_MODES };
  const setMode = (mode: OctantMode, on: boolean) =>
    props.onChange({
      enabled: setting.enabled,
      modes: ALL_MODES.filter((candidate) =>
        candidate === mode ? on : setting.modes.includes(candidate),
      ),
    });
  return (
    <>
      <SettingRow
        description="After each reply, the empty composer shows the message you are likely to send next. Press Tab to use it; nothing is sent for you."
        focused={props.focusedSetting === "next-message-suggestions"}
        label="Suggest my next message"
        scope="app"
        settingId="next-message-suggestions"
      >
        <OctantSwitch
          checked={setting.enabled}
          label="Suggest my next message"
          onCheckedChange={(enabled) => props.onChange({ enabled, modes: setting.modes })}
        />
      </SettingRow>
      {MODE_ROWS.map((row) => (
        <SettingRow
          focused={props.focusedSetting === row.settingId}
          key={row.mode}
          label={row.label}
          scope="app"
          settingId={row.settingId}
        >
          <OctantSwitch
            checked={setting.modes.includes(row.mode)}
            disabled={!setting.enabled}
            disabledReason="Turn on Suggest my next message first."
            label={`Suggest my next message ${row.label.toLowerCase()}`}
            onCheckedChange={(on) => setMode(row.mode, on)}
          />
        </SettingRow>
      ))}
    </>
  );
}
