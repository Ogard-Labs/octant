import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { BottomSheet } from "./BottomSheet";

export interface ModelOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export interface ModelPickerSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly options: ReadonlyArray<ModelOption>;
  readonly selectedId?: string | undefined;
  readonly onSelect: (id: string) => void;
}

export function ModelPickerSheet(props: ModelPickerSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        section: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
          paddingHorizontal: mobileSpacing.md,
          paddingTop: mobileSpacing.sm,
          paddingBottom: mobileSpacing.xs,
        },
        empty: {
          color: colors.textSecondary,
          paddingHorizontal: mobileSpacing.md,
          paddingBottom: mobileSpacing.lg,
          lineHeight: 20,
        },
        row: {
          flexDirection: "row",
          alignItems: "center",
          marginHorizontal: mobileSpacing.sm,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: mobileSpacing.md,
          borderRadius: 14,
        },
        rowSelected: {
          backgroundColor: colors.surface,
        },
        rowText: { flex: 1, gap: 2 },
        label: {
          color: colors.textPrimary,
          fontSize: mobileTypography.body.fontSize,
          fontWeight: "600",
        },
        detail: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
        },
        choiceIcon: {
          width: 30,
          height: 30,
          borderRadius: 15,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.glassFillThin,
        },
      }),
    [colors],
  );

  return (
    <BottomSheet onClose={props.onClose} title="Model" visible={props.visible}>
      <Text style={styles.section}>Active</Text>
      {props.options.length === 0 ? (
        <Text style={styles.empty} testID="mobile-model-empty">
          Connect a host to see advertised models. The phone never stores provider secrets.
        </Text>
      ) : (
        props.options.map((option, index) => {
          const selected = option.id === props.selectedId;
          return (
            <View key={option.id}>
              {index === 1 ? <Text style={styles.section}>More</Text> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => props.onSelect(option.id)}
                style={[styles.row, selected ? styles.rowSelected : null]}
                testID={`mobile-model-option-${option.id}`}
              >
                <View style={styles.rowText}>
                  <Text style={styles.label}>{option.label}</Text>
                  {option.detail !== undefined ? (
                    <Text style={styles.detail}>{option.detail}</Text>
                  ) : null}
                </View>
                {selected ? (
                  <View style={styles.choiceIcon}>
                    <Ionicons color={colors.success} name="checkmark" size={18} />
                  </View>
                ) : (
                  <View style={styles.choiceIcon}>
                    <Ionicons color={colors.textTertiary} name="chevron-forward" size={16} />
                  </View>
                )}
              </Pressable>
            </View>
          );
        })
      )}
    </BottomSheet>
  );
}
