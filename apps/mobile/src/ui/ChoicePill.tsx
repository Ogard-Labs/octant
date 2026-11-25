import { useMemo, useState } from "react";
import { ActionSheetIOS, Platform, Pressable, StyleSheet, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, space, typography, useTheme } from "../../design-system";
import { BottomSheet } from "./BottomSheet";
import { ListRow, ListSection } from "./NativeChrome";

/** A filter as a pill that names its choice; pressing it offers the others. */
export function ChoicePill<Id extends string>(props: {
  readonly title: string;
  readonly options: ReadonlyArray<{ readonly id: Id; readonly label: string }>;
  readonly selected: Id;
  /** The choice that narrows nothing; any other marks the pill as on. */
  readonly neutral?: Id | undefined;
  readonly onSelect: (id: Id) => void;
  readonly testID: string;
}) {
  const { colors, scheme } = useTheme();
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
        labelOn: { color: colors.textPrimary },
        sheet: { paddingBottom: space.lg },
      }),
    [colors],
  );
  const chosen = props.options.find((option) => option.id === props.selected);
  const on = props.neutral !== undefined && props.selected !== props.neutral;
  const offer = () => {
    if (Platform.OS !== "ios") {
      setOpen(true);
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: props.title,
        options: [...props.options.map((option) => option.label), "Cancel"],
        cancelButtonIndex: props.options.length,
        userInterfaceStyle: scheme,
      },
      (index) => {
        const option = props.options[index];
        if (option !== undefined) props.onSelect(option.id);
      },
    );
  };
  return (
    <>
      <Pressable
        accessibilityLabel={`${props.title}, ${chosen?.label ?? ""}`}
        accessibilityRole="button"
        onPress={offer}
        style={({ pressed }) => [
          styles.pill,
          on ? styles.on : null,
          pressed ? styles.pressed : null,
        ]}
        testID={props.testID}
      >
        <Text numberOfLines={1} style={[styles.label, on ? styles.labelOn : null]}>
          {chosen?.label ?? props.title}
        </Text>
        <Ionicons color={colors.textTertiary} name="chevron-down" size={14} />
      </Pressable>
      {open ? (
        <BottomSheet
          contentStyle={styles.sheet}
          onClose={() => setOpen(false)}
          testID={`${props.testID}-sheet`}
          title={props.title}
          visible
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
      ) : null}
    </>
  );
}
