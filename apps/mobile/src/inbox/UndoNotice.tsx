import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { typography, useTheme } from "../../design-system";
import { NEW_BUTTON_CLEARANCE } from "../navigation/places";
import { ComposerSurface } from "../ui/ComposerSurface";

const SHOWN_MS = 5_000;

/** What a swipe just did, with the way back, over the end of the list. */
export function UndoNotice(props: {
  readonly text: string;
  readonly onUndo: () => void;
  readonly onGone: () => void;
}) {
  const { colors } = useTheme();
  const { onGone, text } = props;
  useEffect(() => {
    const timer = setTimeout(onGone, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [onGone, text]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        place: {
          position: "absolute",
          left: 16,
          right: 16,
          bottom: NEW_BUTTON_CLEARANCE,
          alignItems: "center",
        },
        content: {
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 14,
          paddingHorizontal: 18,
        },
        text: { color: colors.textPrimary, fontSize: typography.detail.fontSize },
        undo: {
          color: colors.accent,
          fontSize: typography.detail.fontSize,
          fontWeight: "600",
        },
      }),
    [colors],
  );
  return (
    <View pointerEvents="box-none" style={styles.place}>
      <ComposerSurface contentStyle={styles.content} radius={22}>
        <Text accessibilityLiveRegion="polite" numberOfLines={1} style={styles.text}>
          {text}
        </Text>
        <Pressable
          accessibilityRole="button"
          hitSlop={12}
          onPress={props.onUndo}
          testID="mobile-thread-undo"
        >
          <Text style={styles.undo}>Undo</Text>
        </Pressable>
      </ComposerSurface>
    </View>
  );
}
