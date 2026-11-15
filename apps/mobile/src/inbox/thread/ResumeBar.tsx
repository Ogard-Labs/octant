import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, space, typography, useTheme } from "../../../design-system";

export interface ResumeOffer {
  readonly label: string;
  readonly detail?: string;
  readonly actionLabel: string;
  readonly onPress: () => void;
}

/**
 * A stopped turn's way back, just above an empty composer: Resume or Retry for
 * a Chat turn, and for a Work or Code turn the provider stopped at a usage
 * limit, Resume when it resets (or the scheduled resume with Cancel).
 */
export function ResumeBar(props: { readonly offer: ResumeOffer; readonly busy: boolean }) {
  const { colors } = useTheme();
  const styles = StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      marginHorizontal: space.md,
      marginBottom: space.xs,
      paddingVertical: 6,
      paddingLeft: 12,
      paddingRight: 6,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.glassStroke,
      backgroundColor: colors.glassFillThin,
    },
    text: { flex: 1, gap: 1 },
    label: {
      color: colors.textPrimary,
      fontSize: typography.detail.fontSize,
      fontWeight: "500",
    },
    detail: { color: colors.textSecondary, fontSize: typography.meta.fontSize },
    action: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      minHeight: 30,
      paddingHorizontal: 10,
      borderRadius: radii.sm,
      backgroundColor: colors.control,
    },
    actionLabel: { color: colors.accent, fontSize: typography.detail.fontSize, fontWeight: "500" },
  });
  return (
    <View style={styles.bar} testID="mobile-thread-resume-bar">
      <Ionicons color={colors.textSecondary} name="pause-circle-outline" size={16} />
      <View style={styles.text}>
        <Text style={styles.label}>{props.offer.label}</Text>
        {props.offer.detail === undefined ? null : (
          <Text style={styles.detail}>{props.offer.detail}</Text>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={props.busy}
        onPress={props.offer.onPress}
        style={({ pressed }) => [styles.action, pressed || props.busy ? { opacity: 0.6 } : null]}
        testID="mobile-thread-resume-action"
      >
        <Text style={styles.actionLabel}>{props.offer.actionLabel}</Text>
      </Pressable>
    </View>
  );
}
