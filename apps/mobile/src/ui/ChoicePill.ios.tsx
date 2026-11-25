import { Host, HStack, Image, Menu, Section, Text, Toggle } from "@expo/ui/swift-ui";
import {
  accessibilityIdentifier,
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  font,
  foregroundStyle,
  lineLimit,
} from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../../design-system";
import type { ChoicePillProps } from "./ChoicePill";
import { hasLiquidGlass } from "./systemVersion";

/** A filter as the system's own pull-down button, with its choice checked in the menu. */
export function ChoicePill<Id extends string>(props: ChoicePillProps<Id>) {
  const { colors, scheme } = useTheme();
  const chosen = props.options.find((option) => option.id === props.selected);
  const on = props.neutral !== undefined && props.selected !== props.neutral;
  const ink = on ? colors.accent : colors.textSecondary;
  return (
    <Host colorScheme={scheme} ignoreSafeArea="all" matchContents>
      <Menu
        label={
          <HStack spacing={5}>
            <Text
              modifiers={[
                font({ textStyle: "subheadline", weight: "medium" }),
                foregroundStyle(ink),
                lineLimit(1),
              ]}
            >
              {chosen?.label ?? props.title}
            </Text>
            <Image color={ink} size={10} systemName="chevron.down" />
          </HStack>
        }
        modifiers={[
          buttonStyle(hasLiquidGlass() ? "glass" : "bordered"),
          buttonBorderShape("capsule"),
          accessibilityLabel(`${props.title}, ${chosen?.label ?? ""}`),
          accessibilityIdentifier(props.testID),
        ]}
      >
        <Section title={props.title}>
          {props.options.map((option) => (
            <Toggle
              isOn={option.id === props.selected}
              key={option.id}
              label={option.label}
              onIsOnChange={() => props.onSelect(option.id)}
            />
          ))}
        </Section>
      </Menu>
    </Host>
  );
}
