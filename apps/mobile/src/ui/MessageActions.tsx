import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { MobileIconName } from "./symbols";
import { Icon } from "./Icon";
import { space, typography, useTheme } from "../../design-system";

export interface MessageActionItem {
  readonly id: string;
  readonly label: string;
  readonly icon: MobileIconName;
  readonly onPress: () => void | Promise<void>;
}

/**
 * Message action row for copy and follow-up actions.
 * Glass-adjacent hairline chips use Distilled-owned components and copy.
 */
export function MessageActions(props: {
  readonly actions: ReadonlyArray<MessageActionItem>;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  // The glyphs stand for words, so they follow the text size as words would.
  const { fontScale } = useWindowDimensions();
  const iconSize = Math.round(16 * Math.min(Math.max(fontScale, 1), 2));
  const [activeId, setActiveId] = useState<string | undefined>();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          flexDirection: "row",
          alignItems: "center",
          gap: space.lg,
          marginTop: 2,
          marginBottom: space.sm,
        },
        // Plain glyphs in the muted ink, each with its name spoken; the slop
        // keeps a 44pt target without boxing each one.
        chip: {
          minHeight: 28,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        },
        label: {
          color: colors.textTertiary,
          fontSize: typography.meta.fontSize,
          fontWeight: "500",
        },
        labelActive: {
          color: colors.accent,
        },
      }),
    [colors],
  );

  if (props.actions.length === 0) return null;

  return (
    <View style={styles.row} testID={props.testID ?? "mobile-message-actions"}>
      {props.actions.map((action) => {
        const active = activeId === action.id;
        return (
          <Pressable
            accessibilityLabel={action.label}
            accessibilityRole="button"
            key={action.id}
            onPress={() => {
              void (async () => {
                await action.onPress();
                setActiveId(action.id);
                setTimeout(() => setActiveId(undefined), 1200);
              })();
            }}
            hitSlop={12}
            style={({ pressed }) => [styles.chip, pressed ? { opacity: 0.5 } : null]}
            testID={`mobile-message-action-${action.id}`}
          >
            <Icon
              color={active ? colors.accent : colors.textTertiary}
              name={active && action.id === "copy" ? "checkmark" : action.icon}
              size={iconSize}
            />
            {active && action.id === "copy" ? (
              <Text style={[styles.label, styles.labelActive]}>Copied</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
