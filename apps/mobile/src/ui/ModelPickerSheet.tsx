import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ProviderModelOption, ProviderModelOptionValues } from "@octant/contracts";
import { Icon } from "./Icon";
import { ChoicePill } from "./ChoicePill";
import { modelSettingValueLabel, selectableModelSettings } from "../inbox/modelSettings";
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
  /** What the selected model declares, such as reasoning effort. */
  readonly settings?: ReadonlyArray<ProviderModelOption> | undefined;
  /** The chosen value per option id; an absent id is the model's default. */
  readonly values?: ProviderModelOptionValues | undefined;
  /** `undefined` returns the option to its default. */
  readonly onChangeValue?: ((optionId: string, value: string | undefined) => void) | undefined;
}

const DEFAULT_CHOICE = "default";
const valueChoice = (value: string) => `value:${value}`;

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
          fontWeight: "500",
        },
        detail: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
        },
        settingRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: mobileSpacing.md,
          marginHorizontal: mobileSpacing.sm,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: mobileSpacing.sm,
        },
        settingLabel: {
          flexShrink: 1,
          color: colors.textPrimary,
          fontSize: mobileTypography.body.fontSize,
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

  const selected = props.options.find((option) => option.id === props.selectedId);
  const settings = selectableModelSettings(props.settings);
  return (
    <BottomSheet onClose={props.onClose} title="Model" visible={props.visible}>
      <Text style={styles.section}>Active</Text>
      {props.options.length === 0 ? (
        <Text style={styles.empty} testID="mobile-model-empty">
          Connect a computer to see its models. The phone never stores provider secrets.
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
                    <Icon color={colors.success} name="checkmark" size={18} />
                  </View>
                ) : (
                  <View style={styles.choiceIcon}>
                    <Icon color={colors.textTertiary} name="chevron-forward" size={16} />
                  </View>
                )}
              </Pressable>
            </View>
          );
        })
      )}
      {selected !== undefined && settings.length > 0 && props.onChangeValue !== undefined ? (
        <View>
          <Text style={styles.section}>{selected.label}</Text>
          {settings.map((option) => {
            const current = props.values?.[option.id];
            const onChangeValue = props.onChangeValue;
            return (
              <View key={option.id} style={styles.settingRow}>
                <Text style={styles.settingLabel}>{option.displayName}</Text>
                <ChoicePill
                  look="quiet"
                  onSelect={(id) =>
                    onChangeValue?.(
                      option.id,
                      id === DEFAULT_CHOICE ? undefined : id.slice(valueChoice("").length),
                    )
                  }
                  options={[
                    { id: DEFAULT_CHOICE, label: "Default" },
                    ...option.values.map((value) => ({
                      id: valueChoice(value),
                      label: modelSettingValueLabel(value),
                    })),
                  ]}
                  selected={
                    current !== undefined && option.values.includes(current)
                      ? valueChoice(current)
                      : DEFAULT_CHOICE
                  }
                  testID={`mobile-model-setting-${option.id}`}
                  title={option.displayName}
                />
              </View>
            );
          })}
        </View>
      ) : null}
    </BottomSheet>
  );
}
