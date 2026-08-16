import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  clearMobilePushToken,
  MobileInboxFailure,
  registerMobilePushToken,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";

export interface PushNotificationsPanelProps {
  readonly transport: MobileRemoteTransport | undefined;
  readonly permission: MobileNotificationPermissionPort;
}

export function PushNotificationsPanel(props: PushNotificationsPanelProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const enable = async () => {
    if (props.transport === undefined) {
      setMessage("Connect to a host before enabling notifications.");
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const status = await props.permission.request();
      if (status !== "granted") {
        setMessage("Notification permission was not granted on this phone.");
        return;
      }
      const token = await props.permission.getDevicePushToken();
      if (token === undefined || token.length === 0) {
        setMessage(
          "No device push token is available yet. Live APNs/FCM delivery remains a host residual.",
        );
        return;
      }
      const receipt = await registerMobilePushToken({
        transport: props.transport,
        platform: props.permission.platform,
        token,
      });
      setMessage(`Push token ${receipt.result} on this host.`);
    } catch (cause) {
      setMessage(
        cause instanceof MobileInboxFailure
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Could not enable notifications.",
      );
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (props.transport === undefined) {
      setMessage("Connect to a host before clearing notifications.");
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const receipt = await clearMobilePushToken(props.transport);
      setMessage(`Push token ${receipt.result} on this host.`);
    } catch (cause) {
      setMessage(
        cause instanceof MobileInboxFailure
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Could not clear notifications.",
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
          backgroundColor: colors.accent,
          paddingVertical: mobileSpacing.md,
          borderRadius: 8,
          alignItems: "center",
        },
        buttonDisabled: { opacity: 0.45 },
        buttonLabel: {
          ...mobileTypography.body,
          color: colors.sendLabel,
          fontWeight: "600",
        },
        secondary: { alignItems: "center", paddingVertical: mobileSpacing.sm },
        secondaryLabel: { color: colors.accent, fontWeight: "600" },
        message: { ...mobileTypography.body, color: colors.textPrimary },
      }),
    [colors],
  );

  return (
    <View style={styles.panel} testID="mobile-push-panel">
      <Text style={styles.title}>Notifications</Text>
      <Text style={styles.help}>
        Register a per-host push token for completion, waiting, failure, and approval-needed
        awareness. Payloads stay redacted; live provider delivery needs host credentials.
      </Text>
      <Pressable
        disabled={busy}
        onPress={() => void enable()}
        style={[styles.button, busy ? styles.buttonDisabled : null]}
        testID="mobile-push-enable"
      >
        {busy ? (
          <ActivityIndicator color={colors.sendLabel} />
        ) : (
          <Text style={styles.buttonLabel}>Enable on this host</Text>
        )}
      </Pressable>
      <Pressable
        disabled={busy}
        onPress={() => void disable()}
        style={styles.secondary}
        testID="mobile-push-clear"
      >
        <Text style={styles.secondaryLabel}>Clear token on this host</Text>
      </Pressable>
      {message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}
