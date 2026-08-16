import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ChatAttemptOutcome } from "@octant/contracts";
import { chatAttemptStatusLabel } from "@octant/client-runtime";
import { radii, space, typography, useTheme } from "../../design-system";

/**
 * Distilled attempt status chip for the conversation transcript.
 * Soft idle — accent only while queued/streaming/waiting.
 */
export function AttemptStatus(props: {
  readonly outcome: ChatAttemptOutcome;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  const active =
    props.outcome === "queued" || props.outcome === "streaming" || props.outcome === "waiting";
  const failed = props.outcome === "failed" || props.outcome === "interrupted";
  const styles = useMemo(
    () =>
      StyleSheet.create({
        chip: {
          alignSelf: "flex-start",
          paddingVertical: 4,
          paddingHorizontal: 10,
          borderRadius: radii.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
          backgroundColor: colors.glassFillThin,
          marginBottom: space.xs,
        },
        label: {
          fontSize: typography.caption.fontSize,
          fontWeight: "600",
          color: failed ? colors.danger : active ? colors.accent : colors.textSecondary,
        },
      }),
    [active, colors, failed],
  );

  return (
    <View style={styles.chip} testID={props.testID ?? "mobile-attempt-status"}>
      <Text style={styles.label}>{chatAttemptStatusLabel(props.outcome)}</Text>
    </View>
  );
}
