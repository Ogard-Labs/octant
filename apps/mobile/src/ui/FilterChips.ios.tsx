import { ScrollView, StyleSheet } from "react-native";
import { Button, Host, HStack, Text } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityIdentifier,
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  font,
  foregroundStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { space, useTheme } from "../../design-system";
import type { FilterChipsProps } from "./FilterChips";
import { hasLiquidGlass } from "./systemVersion";

/** One choice among a few as the system's own capsule buttons, the chosen one filled. */
export function FilterChips<Id extends string>(props: FilterChipsProps<Id>) {
  const { colors, scheme } = useTheme();
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
          <Host colorScheme={scheme} ignoreSafeArea="all" key={option.id} matchContents>
            <Button
              modifiers={[
                selected
                  ? buttonStyle(hasLiquidGlass() ? "glassProminent" : "borderedProminent")
                  : buttonStyle(hasLiquidGlass() ? "glass" : "bordered"),
                buttonBorderShape("capsule"),
                ...(selected ? [tint(colors.accent)] : []),
                accessibilityLabel(`${option.label}, ${option.count}`),
                accessibilityIdentifier(`${props.testID}-${option.id}`),
                ...(selected ? [accessibilityAddTraits(["isSelected"])] : []),
              ]}
              onPress={() => props.onSelect(option.id)}
            >
              <HStack spacing={6}>
                <Text
                  modifiers={[
                    font({ textStyle: "subheadline", weight: "medium" }),
                    foregroundStyle(selected ? colors.sendLabel : colors.textSecondary),
                  ]}
                >
                  {option.label}
                </Text>
                {option.count === 0 ? null : (
                  <Text
                    modifiers={[
                      font({ textStyle: "subheadline" }),
                      foregroundStyle(selected ? colors.sendLabel : colors.textTertiary),
                    ]}
                  >
                    {String(option.count)}
                  </Text>
                )}
              </HStack>
            </Button>
          </Host>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // A button's glass casts past the strip, which would cut it off.
  row: { flexGrow: 0, overflow: "visible" },
  content: { gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
});
