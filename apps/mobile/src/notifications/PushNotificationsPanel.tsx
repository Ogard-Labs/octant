import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  clearMobilePushToken,
  MobileInboxFailure,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";
import { ENABLE_REFUSAL_COPY, enablePhoneNotifications } from "./enablePhoneNotifications";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";

export interface PushNotificationsPanelProps {
  readonly transport: MobileRemoteTransport | undefined;
  readonly permission: MobileNotificationPermissionPort;
  /** The paired computer's key fingerprint, which the gateway binds the capability to. */
  readonly hostKeyFingerprint: string;
}

export function PushNotificationsPanel(props: PushNotificationsPanelProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const enable = async () => {
    if (!props.permission.available) return;
    if (props.transport === undefined) {
      setMessage("Connect to a computer before turning on notifications.");
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await enablePhoneNotifications({
        transport: props.transport,
        hostKeyFingerprint: props.hostKeyFingerprint,
        permission: props.permission,
      });
      setMessage(
        result.status === "registered"
          ? "Notifications are on for this computer."
          : ENABLE_REFUSAL_COPY[result.reason],
      );
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
      setMessage("Connect to a computer before clearing notifications.");
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const receipt = await clearMobilePushToken(props.transport);
      setMessage(
        receipt.result === "cleared" || receipt.result === "already-cleared"
          ? "Notifications are off for this computer."
          : "Notifications could not be turned off for this computer.",
      );
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
          fontWeight: "500",
        },
        secondary: { alignItems: "center", paddingVertical: mobileSpacing.sm },
        secondaryLabel: { color: colors.accent, fontWeight: "500" },
        message: { ...mobileTypography.body, color: colors.textPrimary },
      }),
    [colors],
  );

  return (
    <View style={styles.panel} testID="mobile-push-panel">
      <Text style={styles.title}>Notifications</Text>
      {props.permission.available ? (
        <>
          <Text style={styles.help}>
            Hear when a thread on this computer finishes, fails, or waits for you. Notifications are
            sealed so only this phone can read them; the lock screen shows the kind and the
            computer's name.
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
              <Text style={styles.buttonLabel}>Turn on for this computer</Text>
            )}
          </Pressable>
        </>
      ) : (
        <Text style={styles.help} testID="mobile-push-unavailable">
          Push notifications are unavailable in this build. Open Octant to check for updates from
          your paired hosts.
        </Text>
      )}
      {props.transport !== undefined ? (
        <Pressable
          disabled={busy}
          onPress={() => void disable()}
          style={styles.secondary}
          testID="mobile-push-clear"
        >
          <Text style={styles.secondaryLabel}>Turn off for this computer</Text>
        </Pressable>
      ) : null}
      {message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}
