import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_COPY } from "../copy";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import {
  stepRemoveHostFlow,
  type RemoveHostFlowEvent,
  type RemoveHostFlowState,
} from "./removeHostFlow";

export interface RemoveHostPanelProps {
  readonly hostLabel: string;
  /** Deletes this phone's key and connection for the host. Sends nothing to the host. */
  readonly onRemove: () => void;
  readonly testIdSuffix: string;
}

export function RemoveHostPanel(props: RemoveHostPanelProps) {
  const { colors } = useTheme();
  const [state, setState] = useState<RemoveHostFlowState>("idle");

  const send = (event: RemoveHostFlowEvent) => {
    const step = stepRemoveHostFlow(state, event);
    setState(step.state);
    if (step.remove) props.onRemove();
  };

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
        actions: {
          flexDirection: "row",
          gap: mobileSpacing.sm,
        },
        button: {
          flex: 1,
          paddingVertical: mobileSpacing.md,
          borderRadius: 8,
          alignItems: "center",
          backgroundColor: colors.surface,
        },
        dangerButton: {
          backgroundColor: colors.danger,
        },
        buttonLabel: {
          ...mobileTypography.body,
          color: colors.textPrimary,
          fontWeight: "500",
        },
        dangerLabel: {
          color: colors.sendLabel,
        },
      }),
    [colors],
  );

  return (
    <View style={styles.panel} testID={`mobile-host-remove-${props.testIdSuffix}`}>
      {state === "confirming" ? (
        <>
          <Text style={styles.help}>{MOBILE_COPY.removeHostConfirm}</Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityLabel={MOBILE_COPY.removeHostCancel}
              accessibilityRole="button"
              onPress={() => send("cancel")}
              style={styles.button}
              testID={`mobile-host-remove-cancel-${props.testIdSuffix}`}
            >
              <Text style={styles.buttonLabel}>{MOBILE_COPY.removeHostCancel}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`${MOBILE_COPY.removeHostConfirmAction} ${props.hostLabel}`}
              accessibilityRole="button"
              onPress={() => send("confirm")}
              style={[styles.button, styles.dangerButton]}
              testID={`mobile-host-remove-confirm-${props.testIdSuffix}`}
            >
              <Text style={[styles.buttonLabel, styles.dangerLabel]}>
                {MOBILE_COPY.removeHostConfirmAction}
              </Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.help}>{MOBILE_COPY.removeHostHint}</Text>
          <Pressable
            accessibilityLabel={`${MOBILE_COPY.removeHostAction} ${props.hostLabel}`}
            accessibilityRole="button"
            onPress={() => send("ask")}
            style={styles.button}
            testID={`mobile-host-remove-ask-${props.testIdSuffix}`}
          >
            <Text style={styles.buttonLabel}>{MOBILE_COPY.removeHostAction}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
