import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { GlassSurface } from "./GlassSurface";
import { radii, typography } from "./tokens";
import { useTheme } from "./theme";

export interface GlassChipProps {
  readonly label: string;
  readonly active?: boolean;
  readonly onPress?: () => void;
  readonly testID?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly trailing?: ReactNode;
}

// The pill is about 32pt tall; the slop reaches the 44pt minimum without
// changing how the chip looks or the room around it.
const CHIP_HIT_SLOP = { top: 6, bottom: 6, left: 6, right: 6 } as const;

export function GlassChip(props: GlassChipProps) {
  const { colors } = useTheme();
  const active = props.active === true;
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={CHIP_HIT_SLOP}
      onPress={props.onPress}
      style={props.style}
      testID={props.testID}
    >
      <GlassSurface
        contentStyle={styles.content}
        material={active ? "thick" : "thin"}
        radius={radii.pill}
      >
        <Text style={[styles.label, { color: active ? colors.textPrimary : colors.textSecondary }]}>
          {props.label}
        </Text>
        {props.trailing}
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  label: {
    fontSize: typography.caption.fontSize,
    fontWeight: "500",
  },
});
