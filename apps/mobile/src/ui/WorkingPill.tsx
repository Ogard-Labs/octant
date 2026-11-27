import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { typography, useTheme } from "../../design-system";
import { ComposerSurface } from "./ComposerSurface";
import { turnElapsed } from "./turnTime";

/** What the running turn is doing, floating over the end of the transcript. */
export function WorkingPill(props: {
  readonly label: string;
  /** When the turn started; absent, the pill names the state alone. */
  readonly since?: string | undefined;
}) {
  const { colors } = useTheme();
  const { since } = props;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (since === undefined) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, [since]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        place: { alignItems: "center", paddingBottom: 8 },
        content: { paddingHorizontal: 14, paddingVertical: 8 },
        text: {
          color: colors.textPrimary,
          fontSize: typography.caption.fontSize,
          fontWeight: "500",
          fontVariant: ["tabular-nums"],
        },
      }),
    [colors],
  );
  return (
    <View pointerEvents="none" style={styles.place}>
      <ComposerSurface contentStyle={styles.content} radius={18}>
        {/* The clock ticks for the eye; a screen reader hears the state once. */}
        <Text
          accessibilityLabel={props.label}
          maxFontSizeMultiplier={1.6}
          style={styles.text}
          testID="mobile-composer-busy"
        >
          {since === undefined ? props.label : `${props.label} ${turnElapsed(since, now)}`.trim()}
        </Text>
      </ComposerSurface>
    </View>
  );
}
