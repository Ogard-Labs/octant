import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  clearMobilePushToken,
  isRemoteDeviceSelfServiceFailure,
  remoteRevokeSelf,
  type MobileRemoteTransport,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import {
  assertBiometricConfirmed,
  requireBiometricConfirmation,
  type BiometricAuthenticator,
} from "../security/BiometricGate";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";

export interface DeviceRevokePanelProps {
  readonly bridge: RemoteSessionBridge;
  readonly authenticator: BiometricAuthenticator;
  /** When present, best-effort clear of this host’s push token before revoke. */
  readonly transport?: MobileRemoteTransport | undefined;
  readonly onRevoked?: () => void;
}

export function DeviceRevokePanel(props: DeviceRevokePanelProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const revoke = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const biometric = await requireBiometricConfirmation({
        authenticator: props.authenticator,
        reason: "revoke",
      });
      assertBiometricConfirmed(biometric, "Revoke");
      if (props.transport !== undefined) {
        try {
          await clearMobilePushToken(props.transport);
        } catch {
          // Best-effort: revoke must still proceed if push clear fails.
        }
      }
      const result = await remoteRevokeSelf({ bridge: props.bridge });
      setMessage(
        result.localCredentialRemoved
          ? "This phone was revoked on the host. Re-pair to reconnect."
          : (result.warning ?? "Host revoked this device. Local cleanup needs attention."),
      );
      props.onRevoked?.();
    } catch (cause) {
      setMessage(
        isRemoteDeviceSelfServiceFailure(cause)
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Revoke failed.",
      );
    } finally {
      setBusy(false);
    }
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
        title: {
          ...mobileTypography.title,
          color: colors.textPrimary,
        },
        help: {
          ...mobileTypography.body,
          color: colors.textSecondary,
        },
        button: {
          backgroundColor: colors.danger,
          paddingVertical: mobileSpacing.md,
          borderRadius: 8,
          alignItems: "center",
        },
        buttonDisabled: {
          opacity: 0.45,
        },
        buttonLabel: {
          ...mobileTypography.body,
          color: colors.sendLabel,
          fontWeight: "600",
        },
        message: {
          ...mobileTypography.body,
          color: colors.textPrimary,
        },
      }),
    [colors],
  );

  return (
    <View style={styles.panel} testID="mobile-device-revoke">
      <Text style={styles.title}>This device</Text>
      <Text style={styles.help}>
        Revoke removes only this phone’s registration. Other paired clients stay connected.
      </Text>
      <Pressable
        disabled={busy}
        onPress={() => void revoke()}
        style={[styles.button, busy ? styles.buttonDisabled : null]}
        testID="mobile-device-revoke-confirm"
      >
        {busy ? (
          <ActivityIndicator color={colors.sendLabel} />
        ) : (
          <Text style={styles.buttonLabel}>Revoke with biometrics</Text>
        )}
      </Pressable>
      {message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}
