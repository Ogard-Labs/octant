import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import {
  MobileInboxFailure,
  readMobilePushStatus,
  type MobilePushStatusResult,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";
import {
  enablePhoneNotifications,
  forgetPhoneNotificationsForHost,
  formatEnableRefusal,
} from "./enablePhoneNotifications";
import type { PushRegistrationBook } from "./pushRegistrationBook";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";

export interface PushNotificationsPanelProps {
  readonly transport: MobileRemoteTransport | undefined;
  readonly permission: MobileNotificationPermissionPort;
  /** The computer's display name for version-skew and status messages. */
  readonly hostLabel: string;
  /** Which computers this phone registered with, and under which token. */
  readonly book: PushRegistrationBook;
  /** The device id the computer knows this phone by, read from the pairing. */
  readonly resolveDeviceId: () => Promise<string | undefined>;
}

export function PushNotificationsPanel(props: PushNotificationsPanelProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [hostStatus, setHostStatus] = useState<MobilePushStatusResult | undefined>();
  // Present once notifications are registered for this computer; undefined while off.
  const [registered, setRegistered] = useState<
    { readonly newDevices: boolean; readonly threadTitles: boolean } | undefined
  >();
  const hostId = props.transport?.hostId;

  useEffect(() => {
    let live = true;
    void props.book.list().then((records) => {
      const record = records.find((entry) => entry.hostId === hostId);
      if (!live) return;
      setRegistered(
        record === undefined || record.forgetPending === true
          ? undefined
          : {
              newDevices: record.newDevices !== false,
              threadTitles: record.threadTitles === true,
            },
      );
    });
    return () => {
      live = false;
    };
  }, [props.book, hostId, message]);

  useEffect(() => {
    const transport = props.transport;
    if (transport === undefined || !props.permission.available) {
      setHostStatus(undefined);
      return;
    }
    let live = true;
    void readMobilePushStatus(transport).then(async (status) => {
      if (!live) return;
      setHostStatus(status);
      if (status.status === "update-host") {
        await forgetPhoneNotificationsForHost({
          hostId: transport.hostId,
          permission: props.permission,
          book: props.book,
          transport,
        }).catch(() => undefined);
        if (live) setRegistered(undefined);
      }
    });
    return () => {
      live = false;
    };
  }, [props.transport, props.permission, props.book]);

  const updatePreference = async (
    patch: { readonly newDevices?: boolean; readonly threadTitles?: boolean },
    onText: string,
    offText: string,
    enabledValue: boolean,
  ) => {
    if (props.transport === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await enablePhoneNotifications({
        transport: props.transport,
        deviceId: await props.resolveDeviceId(),
        permission: props.permission,
        book: props.book,
        ...patch,
      });
      setMessage(
        result.status === "registered"
          ? enabledValue
            ? onText
            : offText
          : result.status === "cancelled"
            ? "Notifications were turned off for this computer."
            : formatEnableRefusal(result.reason, props.hostLabel),
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not change the setting.");
    } finally {
      setBusy(false);
    }
  };

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
        deviceId: await props.resolveDeviceId(),
        permission: props.permission,
        book: props.book,
      });
      setMessage(
        result.status === "registered"
          ? "Notifications are on for this computer."
          : result.status === "cancelled"
            ? "Notifications were turned off for this computer."
            : formatEnableRefusal(result.reason, props.hostLabel),
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
      const forgotten = await forgetPhoneNotificationsForHost({
        hostId: props.transport.hostId,
        permission: props.permission,
        book: props.book,
        transport: props.transport,
      });
      setMessage(
        !forgotten.localCleared
          ? "Notifications are off, but this phone could not clear its local notification state. Octant will try again the next time it opens."
          : forgotten.clearedOnComputer
            ? "Notifications are off for this computer."
            : "Notifications are off on this phone. The computer could not be told, so it may still try to send them.",
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
        row: { flexDirection: "row", alignItems: "center", gap: mobileSpacing.md },
        rowText: { flex: 1, gap: 2 },
        rowLabel: { ...mobileTypography.body, color: colors.textPrimary },
      }),
    [colors],
  );

  const hostStatusNotice =
    hostStatus?.status === "update-host"
      ? formatEnableRefusal("update-host", props.hostLabel)
      : hostStatus?.status === "ready" && hostStatus.push.status === "unavailable"
        ? formatEnableRefusal(
            hostStatus.push.reason === "no-credentials" ? "host-no-credentials" : "host-push-off",
            props.hostLabel,
          )
        : undefined;

  return (
    <View style={styles.panel} testID="mobile-push-panel">
      <Text style={styles.title}>Notifications</Text>
      {props.permission.available ? (
        <>
          <Text style={styles.help}>
            Hear when a thread on this computer finishes, fails, or waits for you. Notifications are
            sent directly from this computer and show the status and computer name unless you turn
            on Show thread names.
          </Text>
          {hostStatusNotice !== undefined ? (
            <Text style={styles.help} testID="mobile-push-host-notice">
              {hostStatusNotice}
            </Text>
          ) : null}
          <Pressable
            disabled={busy || hostStatus?.status === "update-host"}
            onPress={() => void enable()}
            style={[
              styles.button,
              busy || hostStatus?.status === "update-host" ? styles.buttonDisabled : null,
            ]}
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
      {registered === undefined || !props.permission.available ? null : (
        <>
          <View style={styles.row} testID="mobile-push-thread-titles">
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>Show thread names</Text>
              <Text style={styles.help}>
                Include thread and project names on the lock screen. Checked against secrets on this
                computer before sending.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Show thread names"
              disabled={busy}
              onValueChange={(value) =>
                void updatePreference(
                  { threadTitles: value },
                  "Lock screen notifications will include thread and project names.",
                  "Lock screen notifications will show only status and computer name.",
                  value,
                )
              }
              value={registered.threadTitles}
            />
          </View>
          <View style={styles.row} testID="mobile-push-new-devices">
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>New devices</Text>
              <Text style={styles.help}>
                Hear when a device joins this computer's hub or pairs with it, with its name.
              </Text>
            </View>
            <Switch
              accessibilityLabel="New devices"
              disabled={busy}
              onValueChange={(value) =>
                void updatePreference(
                  { newDevices: value },
                  "This phone will hear when a new device joins or pairs.",
                  "This phone will no longer hear about new devices from this computer.",
                  value,
                )
              }
              value={registered.newDevices}
            />
          </View>
        </>
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
