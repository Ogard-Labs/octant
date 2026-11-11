import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { mix, radii, space, typography, useTheme, withAlpha } from "../../design-system";
import type { MobileIconName } from "./IconButton";

export interface CountTileProps {
  readonly label: string;
  readonly count: number;
  readonly icon: MobileIconName;
  /** The palette hue that names this place (DESIGN.md › Colour). */
  readonly hue: string;
  readonly onPress: () => void;
  readonly testID?: string;
}

/**
 * One count tile, the desktop sidebar's tile projected to the phone. In the
 * light theme the palette hues are dark enough to carry white text on a solid
 * face; in the dark theme they are light, so the face is a tint and the hue
 * moves to the count and the icon instead.
 */
export function CountTile(props: CountTileProps) {
  const { colors, scheme } = useTheme();
  const solid = scheme === "light";
  const ink = solid ? colors.primaryForeground : props.hue;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        pressable: { flex: 1, borderRadius: radii.md },
        face: {
          minHeight: 76,
          justifyContent: "space-between",
          padding: 12,
          borderRadius: radii.md,
          borderWidth: StyleSheet.hairlineWidth,
          overflow: "hidden",
        },
        top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
        count: {
          fontSize: 26,
          fontWeight: "600",
          letterSpacing: -0.6,
          fontVariant: ["tabular-nums"],
          lineHeight: 30,
        },
        label: {
          fontSize: typography.detail.fontSize,
          fontWeight: "500",
          marginTop: space.xs,
        },
      }),
    [],
  );

  const content = (
    <>
      <View style={styles.top}>
        <Text style={[styles.count, { color: ink }]}>{props.count}</Text>
        <Ionicons color={ink} name={props.icon} size={19} />
      </View>
      <Text
        numberOfLines={1}
        style={[styles.label, { color: solid ? colors.primaryForeground : colors.textSecondary }]}
      >
        {props.label}
      </Text>
    </>
  );

  return (
    <Pressable
      accessibilityLabel={`${props.label}, ${props.count}`}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.pressable, pressed ? { opacity: 0.82 } : null]}
      testID={props.testID}
    >
      {solid ? (
        <LinearGradient
          colors={[mix(props.hue, colors.primaryForeground, 0.72), props.hue]}
          end={{ x: 0.9, y: 1 }}
          start={{ x: 0.1, y: 0 }}
          style={[styles.face, { borderColor: withAlpha(props.hue, 0.7) }]}
        >
          {content}
        </LinearGradient>
      ) : (
        <View
          style={[
            styles.face,
            { backgroundColor: withAlpha(props.hue, 0.18), borderColor: withAlpha(props.hue, 0.3) },
          ]}
        >
          {content}
        </View>
      )}
    </Pressable>
  );
}
