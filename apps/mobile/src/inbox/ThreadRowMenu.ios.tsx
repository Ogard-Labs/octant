import { useState } from "react";
import { Alert, StyleSheet } from "react-native";
import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { systemSymbol } from "../ui/symbols";
import { ThreadRowActionsSheet } from "./ThreadRowActionsSheet";
import type { ThreadRowMenuProps } from "./ThreadRowMenu";
import { threadRowActions, type ThreadRowAction } from "./threadRowActions";
import { useThreadRowAction } from "./useThreadRowAction";

function item(action: ThreadRowAction): MenuAction {
  const symbol = systemSymbol(action.icon);
  return {
    id: action.id,
    title: action.value === undefined ? action.label : `${action.label} · ${action.value}`,
    ...(symbol === undefined ? {} : { image: symbol }),
  };
}

/** A thread row with its actions in the system's menu, the row lifted over it. */
export function ThreadRowMenu(props: ThreadRowMenuProps) {
  const [open, setOpen] = useState(false);
  const offers = threadRowActions(props.row, new Date());
  const { busy, run } = useThreadRowAction({
    row: props.row,
    transport: props.transport,
    onDone: props.onChanged,
    onFailed: (message) => Alert.alert(formatScreenshotSafeLabel(props.row.title), message),
  });
  return (
    <>
      <MenuView
        actions={offers.map((offer): MenuAction => {
          if (offer.kind === "action") return item(offer.action);
          if (offer.kind === "choice")
            return { id: offer.label, title: offer.label, subactions: offer.actions.map(item) };
          const symbol = systemSymbol(offer.icon);
          return {
            id: offer.id,
            title: offer.label,
            ...(symbol === undefined ? {} : { image: symbol }),
          };
        })}
        onPressAction={({ nativeEvent }) => {
          const refused = offers.find(
            (offer) => offer.kind === "refused" && offer.id === nativeEvent.event,
          );
          // A menu has no room for a reason, so pressing the action says it.
          if (refused?.kind === "refused") {
            Alert.alert(refused.label, refused.reason);
            return;
          }
          // A row can stand for hours before its menu opens, so a snooze is
          // counted from the press and not from when the row was drawn.
          const action = threadRowActions(props.row, new Date())
            .flatMap((offer) =>
              offer.kind === "refused"
                ? []
                : offer.kind === "choice"
                  ? offer.actions
                  : [offer.action],
            )
            .find((entry) => entry.id === nativeEvent.event);
          if (action !== undefined && !busy) run(action.run);
        }}
        shouldOpenOnLongPress
        style={styles.row}
      >
        {props.children({ onOffer: () => setOpen(true) })}
      </MenuView>
      {open ? (
        <ThreadRowActionsSheet
          onChanged={props.onChanged}
          onClose={() => setOpen(false)}
          row={props.row}
          transport={props.transport}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({ row: { alignSelf: "stretch" } });
