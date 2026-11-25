import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { mix, typography, useTheme, withAlpha } from "../../design-system";
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
  // A place with nothing in it steps back to a plain glass tile in the muted
  // ink, so the tiles that do hold something are what the eye lands on.
  const quiet = props.count === 0;
  const solid = scheme === "light" && !quiet;
  const ink = quiet ? colors.textTertiary : solid ? colors.primaryForeground : props.hue;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        pressable: { flex: 1, borderRadius: 16 },
        face: {
          minHeight: 86,
          justifyContent: "space-between",
          paddingHorizontal: 12,
          paddingVertical: 12,
          borderRadius: 16,
          borderWidth: StyleSheet.hairlineWidth,
          overflow: "hidden",
        },
        top: { flexDirection: "row", alignItems: "center", gap: 7 },
        count: {
          fontSize: 24,
          fontWeight: "700",
          letterSpacing: -0.4,
          fontVariant: ["tabular-nums"],
          lineHeight: 28,
        },
        label: {
          fontSize: typography.detail.fontSize,
          flexShrink: 1,
          fontWeight: "600",
        },
      }),
    [],
  );

  const content = (
    <>
      <View style={styles.top}>
        <Ionicons color={ink} name={props.icon} size={16} />
        <Text
          numberOfLines={1}
          style={[styles.label, { color: solid ? colors.primaryForeground : colors.textSecondary }]}
        >
          {props.label}
        </Text>
      </View>
      <Text style={[styles.count, { color: ink }]}>{props.count}</Text>
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
            quiet
              ? { backgroundColor: colors.glassFillThin, borderColor: colors.glassStroke }
              : {
                  backgroundColor: withAlpha(props.hue, 0.18),
                  borderColor: withAlpha(props.hue, 0.3),
                },
          ]}
        >
          {content}
        </View>
      )}
    </Pressable>
  );
}
