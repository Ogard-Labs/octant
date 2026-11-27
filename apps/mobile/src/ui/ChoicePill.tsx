import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { Icon } from "./Icon";
import { radii, space, typography, useTheme } from "../../design-system";
import { BottomSheet } from "./BottomSheet";
import { ListRow, ListSection } from "./NativeChrome";

export interface ChoicePillProps<Id extends string> {
  readonly title: string;
  readonly options: ReadonlyArray<{ readonly id: Id; readonly label: string }>;
  readonly selected: Id;
  /** The choice that narrows nothing; any other marks the pill as on. */
  readonly neutral?: Id | undefined;
  readonly onSelect: (id: Id) => void;
  /** A filter's pill; or a choice inside a sentence, or under one. */
  readonly look?: "pill" | "title" | "quiet";
  readonly testID: string;
}

/** A filter as a pill that names its choice; pressing it offers the others. */
export function ChoicePill<Id extends string>(props: ChoicePillProps<Id>) {
  const { colors } = useTheme();
  const look = props.look ?? "pill";
  const [open, setOpen] = useState(false);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        pill: {
          height: 34,
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: 13,
          borderRadius: radii.pill,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairlineStrong,
          backgroundColor: colors.control,
        },
        on: { borderColor: colors.accent },
        pressed: { backgroundColor: colors.controlPressed },
        label: { maxWidth: 180, color: colors.textSecondary, fontSize: typography.body.fontSize },
        bare: {
          backgroundColor: "transparent",
          borderWidth: 0,
          height: "auto",
          paddingHorizontal: 0,
        },
        title: {
          maxWidth: 300,
          color: colors.textPrimary,
          fontSize: 24,
          fontWeight: "600",
          textDecorationLine: "underline",
          textDecorationColor: colors.textTertiary,
        },
        quiet: { fontSize: typography.detail.fontSize },
        labelOn: { color: colors.textPrimary },
        sheet: { paddingBottom: space.lg },
      }),
    [colors],
  );
  const chosen = props.options.find((option) => option.id === props.selected);
  const on = props.neutral !== undefined && props.selected !== props.neutral;
  return (
    <>
      <Pressable
        accessibilityLabel={`${props.title}, ${chosen?.label ?? ""}`}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.pill,
          look === "pill" ? null : styles.bare,
          on ? styles.on : null,
          pressed ? styles.pressed : null,
        ]}
        testID={props.testID}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.label,
            look === "title" ? styles.title : look === "quiet" ? styles.quiet : null,
            on ? styles.labelOn : null,
          ]}
        >
          {chosen?.label ?? props.title}
        </Text>
        <Icon color={colors.textTertiary} name="chevron-down" size={14} />
      </Pressable>
      <BottomSheet
        contentStyle={styles.sheet}
        onClose={() => setOpen(false)}
        size="fitted"
        testID={`${props.testID}-sheet`}
        title={props.title}
        visible={open}
      >
        <ListSection>
          {props.options.map((option, index) => (
            <ListRow
              accessory={option.id === props.selected ? "check" : "none"}
              key={option.id}
              label={option.label}
              last={index === props.options.length - 1}
              onPress={() => {
                setOpen(false);
                props.onSelect(option.id);
              }}
              testID={`${props.testID}-${option.id}`}
            />
          ))}
        </ListSection>
      </BottomSheet>
    </>
  );
}
