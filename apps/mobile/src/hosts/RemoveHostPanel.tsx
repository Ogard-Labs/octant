import { useMemo } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_COPY } from "../copy";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";

export interface RemoveHostPanelProps {
  readonly hostLabel: string;
  /** Deletes this phone's key and connection for the host. Sends nothing to the host. */
  readonly onRemove: () => void;
  readonly testIdSuffix: string;
}

export function RemoveHostPanel(props: RemoveHostPanelProps) {
  const { colors } = useTheme();
  // Remove asks once, in the system's alert, before it deletes anything,
  // because it never reaches the computer: the computer keeps listing this
  // phone until it is revoked there.
  const ask = () =>
    Alert.alert(props.hostLabel, MOBILE_COPY.removeHostConfirm, [
      { text: MOBILE_COPY.removeHostCancel, style: "cancel" },
      { text: MOBILE_COPY.removeHostConfirmAction, style: "destructive", onPress: props.onRemove },
    ]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: {
          marginTop: mobileSpacing.lg,
          gap: mobileSpacing.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          paddingTop: mobileSpacing.md,
        },
        help: {
          ...mobileTypography.body,
          color: colors.textSecondary,
        },
        button: {
          flex: 1,
          paddingVertical: mobileSpacing.md,
          borderRadius: 8,
          alignItems: "center",
          backgroundColor: colors.surface,
        },
        buttonLabel: {
          ...mobileTypography.body,
          color: colors.textPrimary,
          fontWeight: "500",
        },
      }),
    [colors],
  );

  return (
    <View style={styles.panel} testID={`mobile-host-remove-${props.testIdSuffix}`}>
      <Text style={styles.help}>{MOBILE_COPY.removeHostHint}</Text>
      <Pressable
        accessibilityLabel={`${MOBILE_COPY.removeHostAction} ${props.hostLabel}`}
        accessibilityRole="button"
        onPress={ask}
        style={styles.button}
        testID={`mobile-host-remove-ask-${props.testIdSuffix}`}
      >
        <Text style={styles.buttonLabel}>{MOBILE_COPY.removeHostAction}</Text>
      </Pressable>
    </View>
  );
}
