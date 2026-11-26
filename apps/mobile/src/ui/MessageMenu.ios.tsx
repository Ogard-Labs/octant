import { View } from "react-native";
import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import type { MessageMenuProps } from "./MessageMenu";
import { systemSymbol } from "./symbols";

/**
 * A message with its actions in the system's menu on a long press, the
 * message lifted over it. The same actions stay under the message for one tap.
 */
export function MessageMenu(props: MessageMenuProps) {
  if (props.actions.length === 0) return <View style={props.style}>{props.children}</View>;
  return (
    <MenuView
      actions={props.actions.map((action): MenuAction => {
        const symbol = systemSymbol(action.icon);
        return {
          id: action.id,
          title: action.label,
          ...(symbol === undefined ? {} : { image: symbol }),
        };
      })}
      onPressAction={({ nativeEvent }) => {
        const action = props.actions.find((entry) => entry.id === nativeEvent.event);
        if (action !== undefined) void action.onPress();
      }}
      shouldOpenOnLongPress
      {...(props.style === undefined ? {} : { style: props.style })}
    >
      {props.children}
    </MenuView>
  );
}
