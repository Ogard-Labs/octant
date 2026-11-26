import {
  useTurnSendPreference,
  writeTurnSendPreference,
  type TurnSendPreference,
} from "../messageQueue/turnSendPreference";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { SettingRow } from "./primitives";

/**
 * What a Work or Code message sent while a turn runs does on this client.
 * Kept on this client only; ⌘↩ does the other for one message.
 */
export function TurnSendSettings(props: { readonly focused: boolean }) {
  const preference = useTurnSendPreference();
  return (
    <SettingRow
      description="In Work and Code, a message you send while a turn runs either steers that turn, where its model can take it, or waits in the queue for the next turn. ⌘↩ (Ctrl+↩) does the other for one message. Kept on this device only."
      focused={props.focused}
      label="While a turn runs"
      scope="app"
      settingId="while-turn-runs"
    >
      <OctantToggleGroup<TurnSendPreference>
        aria-label="While a turn runs"
        onValueChange={(value) => {
          const selected = value[0];
          if (selected !== undefined) writeTurnSendPreference(selected);
        }}
        value={[preference]}
      >
        <OctantToggleGroupItem value="steer">Steer</OctantToggleGroupItem>
        <OctantToggleGroupItem value="queue">Queue</OctantToggleGroupItem>
      </OctantToggleGroup>
    </SettingRow>
  );
}
