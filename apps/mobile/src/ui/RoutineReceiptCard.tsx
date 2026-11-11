import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ThreadRoutineReceipt } from "@octant/contracts";
import { routineScheduleLabel } from "@octant/domain";
import { Ionicons } from "@expo/vector-icons";
import { radii, space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";

/**
 * What a thread's tool call set up, as a card under the turn: the routine's
 * name, when it runs, and that it was created paused when the person asked for
 * it. A receipt of what was created, so it never claims the routine's current
 * state. It reads the same receipt the desktop and web thread cards read.
 */
export function RoutineReceiptCard(props: {
  readonly routine: ThreadRoutineReceipt;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingVertical: space.sm,
          paddingHorizontal: space.md,
          borderRadius: radii.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
          backgroundColor: colors.glassFillThin,
        },
        text: { flex: 1, minWidth: 0 },
        label: { fontSize: typography.caption.fontSize, color: colors.textSecondary },
        title: { fontSize: typography.body.fontSize, color: colors.textPrimary },
        detail: { fontSize: typography.caption.fontSize, color: colors.textSecondary },
      }),
    [colors],
  );
  const { routine } = props;
  return (
    <View
      accessibilityLabel={`${MOBILE_COPY.routineReceiptLabel}: ${routine.name}`}
      style={styles.card}
      testID={props.testID ?? "mobile-routine-receipt"}
    >
      <Ionicons color={colors.textSecondary} name="calendar-outline" size={18} />
      <View style={styles.text}>
        <Text style={styles.label}>{MOBILE_COPY.routineReceiptLabel}</Text>
        <Text numberOfLines={1} style={styles.title}>
          {routine.name}
        </Text>
        <Text numberOfLines={1} style={styles.detail}>
          {routineScheduleLabel(routine.trigger)}
          {routine.paused ? ` · ${MOBILE_COPY.routineReceiptPaused}` : ""}
        </Text>
      </View>
    </View>
  );
}
