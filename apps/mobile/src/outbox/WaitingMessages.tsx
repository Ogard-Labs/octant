import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_COPY } from "../copy";
import { radii, space, typography, useTheme } from "../../design-system";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { Icon } from "../ui/Icon";
import type { WaitingMessage } from "./outbox";

/** What this phone still holds for the thread, at the end of its transcript. */
export function WaitingMessages(props: {
  readonly messages: ReadonlyArray<WaitingMessage>;
  readonly onEdit: (message: WaitingMessage) => void;
  readonly onDelete: (message: WaitingMessage) => void;
  readonly onTryAgain: (message: WaitingMessage) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        message: { alignItems: "flex-end", gap: 4, paddingTop: space.sm },
        bubble: {
          maxWidth: "84%",
          borderRadius: radii.bubble,
          paddingHorizontal: 14,
          paddingVertical: 10,
          backgroundColor: colors.userBubble,
          opacity: 0.6,
        },
        text: { color: colors.textPrimary, fontSize: typography.body.fontSize, lineHeight: 22 },
        line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md },
        state: { flexDirection: "row", flexShrink: 1, alignItems: "center", gap: 5 },
        stateText: {
          flexShrink: 1,
          color: colors.textTertiary,
          fontSize: typography.meta.fontSize,
        },
        action: {
          color: colors.accent,
          fontSize: typography.meta.fontSize,
          fontWeight: "600",
          paddingVertical: 6,
        },
      }),
    [colors],
  );
  return props.messages.map((message) => {
    const state =
      message.refused ??
      (message.attempted === true ? MOBILE_COPY.outboxMayBeSent : MOBILE_COPY.outboxWaiting);
    const action = (label: string, onPress: () => void) => (
      <Pressable accessibilityRole="button" hitSlop={8} key={label} onPress={onPress}>
        <Text style={styles.action}>{label}</Text>
      </Pressable>
    );
    return (
      <View key={message.id} style={styles.message} testID={`mobile-outbox-${message.id}`}>
        <View style={styles.bubble}>
          <Text style={styles.text}>{message.text}</Text>
        </View>
        <View style={styles.line}>
          <View style={styles.state}>
            <Icon
              color={message.refused === undefined ? colors.textTertiary : colors.danger}
              name={message.refused === undefined ? "time-outline" : "alert-circle-outline"}
              size={13}
            />
            <Text accessibilityLiveRegion="polite" style={styles.stateText}>
              {formatScreenshotSafeLabel(state)}
            </Text>
          </View>
          {message.refused === undefined
            ? null
            : action(MOBILE_COPY.outboxTryAgain, () => props.onTryAgain(message))}
          {/* Words its computer may already have are not changed into others. */}
          {message.attempted === true && message.refused === undefined
            ? null
            : action(MOBILE_COPY.outboxEdit, () => props.onEdit(message))}
          {action(MOBILE_COPY.outboxDelete, () => props.onDelete(message))}
        </View>
      </View>
    );
  });
}
