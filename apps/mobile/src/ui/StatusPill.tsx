import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { radii, typography, useTheme } from "../../design-system";

export interface StatusPillProps {
  readonly label: string;
  readonly count: number;
  /** Colour of the leading dot, and of the outline and count when emphasized. */
  readonly tone: string;
  /** Raised when the count asks something of the person, such as an approval waiting. */
  readonly emphasized?: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}

// The pill is 32pt tall; the slop reaches the 44pt minimum without changing
// how the row of pills looks or the room between them.
const PILL_HIT_SLOP = { top: 6, bottom: 6, left: 3, right: 3 } as const;

/**
 * One status filter on the phone's home. A row of these replaces the large
 * status tiles so the threads themselves sit above the fold.
 */
export function StatusPill(props: StatusPillProps) {
  const { colors } = useTheme();
  const emphasized = props.emphasized === true;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        pill: {
          height: 32,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 11,
          borderRadius: radii.pill,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
          backgroundColor: colors.glassFillThin,
        },
        pressed: { backgroundColor: colors.glassFillThick },
        dot: { width: 6, height: 6, borderRadius: 3 },
        label: {
          color: colors.textPrimary,
          fontSize: typography.caption.fontSize,
          fontWeight: "500",
        },
        count: {
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          fontVariant: ["tabular-nums"],
        },
      }),
    [colors],
  );

  return (
    <Pressable
      accessibilityLabel={`${props.label}, ${props.count}`}
      accessibilityRole="button"
      hitSlop={PILL_HIT_SLOP}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.pill,
        emphasized ? { borderColor: props.tone } : null,
        pressed ? styles.pressed : null,
      ]}
      testID={props.testID}
    >
      <View style={[styles.dot, { backgroundColor: props.tone }]} />
      <Text style={styles.label}>{props.label}</Text>
      <Text style={[styles.count, emphasized ? { color: props.tone } : null]}>{props.count}</Text>
    </Pressable>
  );
}
