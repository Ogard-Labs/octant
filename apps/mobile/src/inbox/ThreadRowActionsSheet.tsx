import { Fragment, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { MobileInboxRow, MobileRemoteTransport } from "@octant/client-runtime";
import { space, typography, useTheme } from "../../design-system";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { BottomSheet } from "../ui/BottomSheet";
import { ListNote, ListRow, ListSection } from "../ui/NativeChrome";
import { threadRowActions } from "./threadRowActions";
import { useThreadRowAction } from "./useThreadRowAction";

/**
 * A thread row's actions in a sheet, for a screen reader and where the system
 * has no row menu. One the host would refuse shows the reason instead.
 */
export function ThreadRowActionsSheet(props: {
  readonly row: MobileInboxRow;
  readonly transport: MobileRemoteTransport | undefined;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const { colors } = useTheme();
  const [message, setMessage] = useState<string | undefined>();
  const { busy, run } = useThreadRowAction({
    row: props.row,
    transport: props.transport,
    onDone: () => {
      props.onChanged();
      props.onClose();
    },
    onFailed: setMessage,
  });
  const styles = StyleSheet.create({
    message: {
      color: colors.danger,
      fontSize: typography.detail.fontSize,
      paddingHorizontal: space.md,
      paddingBottom: space.sm,
    },
    body: { paddingBottom: space.lg },
  });
  const [first, ...rest] = threadRowActions(props.row, new Date());
  const offered = (offer: typeof first, last: boolean) => {
    if (offer === undefined) return null;
    if (offer.kind === "refused")
      return offer.id === "snooze" ? (
        <ListNote last={last} text={offer.reason} tone={colors.textSecondary} />
      ) : (
        <ListRow
          detail={offer.reason}
          icon={offer.icon}
          label={offer.label}
          last={last}
          testID={`mobile-thread-action-${offer.id}`}
        />
      );
    const actions = offer.kind === "choice" ? offer.actions : [offer.action];
    return actions.map((action, index) => (
      <ListRow
        icon={action.icon}
        key={action.id}
        label={action.label}
        last={last && index === actions.length - 1}
        onPress={
          busy
            ? undefined
            : () => {
                setMessage(undefined);
                run(action.run);
              }
        }
        testID={`mobile-thread-action-${action.id}`}
        {...(action.value === undefined ? {} : { value: action.value })}
      />
    ));
  };

  return (
    <BottomSheet
      onClose={props.onClose}
      testID="mobile-thread-row-actions"
      title={formatScreenshotSafeLabel(props.row.title)}
      visible
    >
      <View style={styles.body}>
        {message === undefined ? null : <Text style={styles.message}>{message}</Text>}
        <ListSection
          {...(first?.kind === "action" || first === undefined ? {} : { title: first.label })}
        >
          {offered(first, true)}
        </ListSection>
        <ListSection>
          {rest.map((offer, index) => (
            <Fragment key={index}>{offered(offer, index === rest.length - 1)}</Fragment>
          ))}
        </ListSection>
      </View>
    </BottomSheet>
  );
}
