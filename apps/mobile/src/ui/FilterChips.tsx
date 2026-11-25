import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { radii, space, useTheme } from "../../design-system";

export interface FilterChipsProps<Id extends string> {
  readonly options: ReadonlyArray<{
    readonly id: Id;
    readonly label: string;
    readonly count: number;
  }>;
  readonly selected: Id;
  readonly onSelect: (id: Id) => void;
  readonly testID: string;
}

/** One choice among a few, each with how many it holds. */
export function FilterChips<Id extends string>(props: FilterChipsProps<Id>) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { flexGrow: 0 },
        content: { gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
        chip: {
          height: 34,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 13,
          borderRadius: radii.pill,
          backgroundColor: colors.control,
        },
        selected: { backgroundColor: colors.controlPressed },
        label: { color: colors.textSecondary, fontSize: 14, fontWeight: "500" },
        labelSelected: { color: colors.textPrimary },
        count: { color: colors.textTertiary, fontSize: 13, fontVariant: ["tabular-nums"] },
      }),
    [colors],
  );
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.row}
      testID={props.testID}
    >
      {props.options.map((option) => {
        const selected = option.id === props.selected;
        return (
          <Pressable
            accessibilityLabel={`${option.label}, ${option.count}`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            key={option.id}
            onPress={() => props.onSelect(option.id)}
            style={[styles.chip, selected ? styles.selected : null]}
            testID={`${props.testID}-${option.id}`}
          >
            <Text style={[styles.label, selected ? styles.labelSelected : null]}>
              {option.label}
            </Text>
            <Text style={styles.count}>{option.count}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
