import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ThreadMessageQueueSnapshot } from "@octant/contracts";
import { MOBILE_COPY } from "../../copy";
import { radii, space, typography, useTheme } from "../../../design-system";
import { IconButton } from "../../ui/IconButton";

/** What waits on the computer behind the running turn, above the composer. */
export function QueuedMessages(props: {
  readonly queue: ThreadMessageQueueSnapshot;
  readonly onRemove: ((messageId: string) => void) | undefined;
}) {
  const { colors } = useTheme();
  const { items, holdReason, paused } = props.queue;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          marginHorizontal: space.md,
          marginBottom: space.xs,
          borderRadius: radii.md,
          backgroundColor: colors.control,
          paddingVertical: 4,
        },
        row: {
          minHeight: 40,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingLeft: 12,
          paddingRight: 4,
        },
        state: { color: colors.textTertiary, fontSize: typography.caption.fontSize },
        text: { flex: 1, color: colors.textPrimary, fontSize: typography.detail.fontSize },
        hold: {
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          paddingHorizontal: 12,
          paddingVertical: 4,
        },
      }),
    [colors],
  );
  if (items.length === 0) return null;
  return (
    <View style={styles.card} testID="mobile-thread-queue">
      {paused || holdReason !== undefined ? (
        <Text style={styles.hold}>{MOBILE_COPY.queueHeld}</Text>
      ) : null}
      {items.map((item) => {
        const sending = item.steering === true || item.status !== "queued";
        return (
          <View key={item.messageId} style={styles.row}>
            <Text style={styles.state}>
              {sending ? MOBILE_COPY.queueSending : MOBILE_COPY.queueWaiting}
            </Text>
            <Text numberOfLines={1} style={styles.text}>
              {item.payload?.prompt ?? MOBILE_COPY.queueUnreadable}
            </Text>
            {sending || props.onRemove === undefined ? null : (
              <IconButton
                accessibilityLabel={MOBILE_COPY.queueRemove}
                name="close"
                onPress={() => props.onRemove?.(String(item.messageId))}
                size={32}
                testID={`mobile-thread-queue-remove-${item.messageId}`}
                variant="ghost"
              />
            )}
          </View>
        );
      })}
    </View>
  );
}
