import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { space, typography, useTheme } from "../../design-system";

export interface SegmentedControlProps<Id extends string> {
  readonly options: ReadonlyArray<{ readonly id: Id; readonly label: string }>;
  readonly selected: Id;
  readonly onSelect: (id: Id) => void;
  readonly testID?: string;
  readonly optionTestID?: (id: Id) => string;
}

/** One track, the chosen segment raised, where the system has no control of its own. */
export function SegmentedControl<Id extends string>(props: SegmentedControlProps<Id>) {
  const { colors, scheme, surfaceStyle } = useTheme();
  const glass = surfaceStyle === "glass";
  const styles = useMemo(
    () =>
      StyleSheet.create({
        track: {
          flexDirection: "row",
          padding: 2,
          borderRadius: 9,
          backgroundColor: glass ? colors.glassFillThin : colors.control,
        },
        segment: {
          flex: 1,
          height: 30,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: space.sm,
          borderRadius: 7,
        },
        // In dark the raised fill matched the track, so the thumb takes the
        // strong border grey there, as the system's dark thumb is lighter.
        selected: {
          backgroundColor: glass
            ? colors.glassThumb
            : scheme === "dark"
              ? colors.hairlineStrong
              : colors.surfaceElevatedSolid,
          shadowColor: colors.shadow,
          shadowOpacity: 0.12,
          shadowRadius: 3,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        },
        label: { fontSize: typography.detail.fontSize, color: colors.textPrimary },
      }),
    [colors, glass, scheme],
  );
  return (
    <View accessibilityRole="tablist" style={styles.track} testID={props.testID}>
      {props.options.map((option) => {
        const selected = option.id === props.selected;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            hitSlop={{ top: 7, bottom: 7 }}
            key={option.id}
            onPress={() => props.onSelect(option.id)}
            style={[styles.segment, selected ? styles.selected : null]}
            testID={props.optionTestID?.(option.id)}
          >
            <Text
              numberOfLines={1}
              style={[styles.label, { fontWeight: selected ? "600" : "400" }]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
