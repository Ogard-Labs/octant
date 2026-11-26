import { Host, HStack, Image, Menu, Section, Text, Toggle } from "@expo/ui/swift-ui";
import {
  accessibilityIdentifier,
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  font,
  foregroundStyle,
  lineLimit,
  underline,
} from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../../design-system";
import type { ChoicePillProps } from "./ChoicePill";
import { hasLiquidGlass } from "./systemVersion";

/** A filter as the system's own pull-down button, with its choice checked in the menu. */
export function ChoicePill<Id extends string>(props: ChoicePillProps<Id>) {
  const { colors, scheme } = useTheme();
  const chosen = props.options.find((option) => option.id === props.selected);
  const on = props.neutral !== undefined && props.selected !== props.neutral;
  const look = props.look ?? "pill";
  const ink = on ? colors.accent : colors.textSecondary;
  return (
    <Host colorScheme={scheme} ignoreSafeArea="all" matchContents>
      <Menu
        label={
          <HStack spacing={5}>
            <Text
              modifiers={[
                look === "title"
                  ? font({ textStyle: "title2", weight: "semibold" })
                  : font({ textStyle: "subheadline", weight: "medium" }),
                foregroundStyle(look === "title" ? colors.textPrimary : ink),
                lineLimit(1),
                ...(look === "title" ? [underline({ isActive: true, pattern: "solid" })] : []),
              ]}
            >
              {chosen?.label ?? props.title}
            </Text>
            <Image color={ink} size={10} systemName="chevron.down" />
          </HStack>
        }
        modifiers={[
          ...(look === "pill"
            ? [buttonStyle(hasLiquidGlass() ? "glass" : "bordered"), buttonBorderShape("capsule")]
            : [buttonStyle("plain")]),
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
