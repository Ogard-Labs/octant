import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, space, typography, useTheme } from "../../design-system";

export interface MessageActionItem {
  readonly id: string;
  readonly label: string;
  readonly icon: keyof typeof Ionicons.glyphMap;
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
  const [activeId, setActiveId] = useState<string | undefined>();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          marginTop: space.xs,
          marginBottom: space.sm,
          paddingLeft: 2,
        },
        chip: {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingVertical: 4,
          paddingHorizontal: 8,
          borderRadius: radii.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
          backgroundColor: colors.glassFillThin,
        },
        label: {
          color: colors.textSecondary,
          fontSize: 11,
          fontWeight: "600",
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
            style={styles.chip}
            testID={`mobile-message-action-${action.id}`}
          >
            <Ionicons
              color={active ? colors.accent : colors.textSecondary}
              name={active && action.id === "copy" ? "checkmark" : action.icon}
              size={12}
            />
            <Text style={[styles.label, active ? styles.labelActive : null]}>
              {active && action.id === "copy" ? "Copied" : action.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
