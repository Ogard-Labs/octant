import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  ownerActionNotice,
  readOwnerAlerts,
  runOwnerAlertAction,
  type OwnerActionNotice,
  type OwnerAlertAction,
  type OwnerAlertReading,
  type OwnerAlertRow,
  type OwnerSpoke,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import { mobilePinnedListenerTransport } from "../runtime/mobilePinnedListenerTransport";
import { useTheme } from "../../design-system";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import type { GuestHubStore } from "./hubGuestFlow";
import { ownerSpokesOf } from "./ownerFlow";
import type { PhoneUnlockKey } from "./ownerUnlockKey";

export interface OwnerAlertsPanelProps {
  readonly guestHubStore: GuestHubStore;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly unlockKey: PhoneUnlockKey;
}

const ACTION_LABEL: Readonly<Record<OwnerAlertAction, string>> = {
  confirm: "Confirm",
  remove: "Remove",
  dismiss: "Dismiss",
};

const ACTION_DONE: Readonly<Record<OwnerAlertAction, string>> = {
  confirm: "Confirmed. The member can now act on that computer.",
  remove: "Removed from that computer. Check the hub too.",
  dismiss: "Dismissed.",
};

/**
 * New-member alerts raised by the computers on the hub this phone is an owner
 * of. Each action asks for the unlock first; nothing changes without it.
 */
export function OwnerAlertsPanel(props: OwnerAlertsPanelProps) {
  const { colors } = useTheme();
  const [spokes, setSpokes] = useState<ReadonlyArray<OwnerSpoke>>([]);
  const [reading, setReading] = useState<OwnerAlertReading>();
  const [notice, setNotice] = useState<OwnerActionNotice>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const state = await props.guestHubStore.load();
      const owned =
        state === undefined
          ? []
          : await ownerSpokesOf({
              state,
              deviceKeyStore: props.deviceKeyStore,
              transport: mobilePinnedListenerTransport,
              unlockKey: props.unlockKey,
            });
      setSpokes(owned);
      setReading(owned.length === 0 ? undefined : await readOwnerAlerts(owned));
    } catch {
      setNotice({ tone: "problem", message: "Couldn't read the alerts. Try again." });
    } finally {
      setBusy(false);
    }
  }, [props.deviceKeyStore, props.guestHubStore, props.unlockKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (row: OwnerAlertRow, action: OwnerAlertAction) => {
    const spoke = spokes.find((entry) => entry.memberId === row.spoke.memberId);
    if (spoke === undefined) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await runOwnerAlertAction(spoke, row, action);
      setNotice(ownerActionNotice(result, ACTION_DONE[action]));
    } catch {
      setNotice({ tone: "problem", message: "Nothing changed. Try again." });
    } finally {
      setBusy(false);
    }
    await load();
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: { gap: mobileSpacing.md },
        title: {
          color: colors.textPrimary,
          fontSize: mobileTypography.title.fontSize,
          fontWeight: mobileTypography.title.fontWeight,
        },
        help: { color: colors.textSecondary, fontSize: mobileTypography.caption.fontSize },
        box: {
          gap: mobileSpacing.sm,
          padding: mobileSpacing.md,
          backgroundColor: colors.surface,
          borderRadius: mobileRadii.md,
        },
        boxTitle: { color: colors.textPrimary, fontWeight: "500" },
        body: { color: colors.textSecondary },
        mono: { color: colors.textSecondary, fontFamily: "Menlo", fontSize: 11 },
        actions: { flexDirection: "row", gap: mobileSpacing.sm, flexWrap: "wrap" },
        button: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.accent,
          paddingVertical: mobileSpacing.sm,
          paddingHorizontal: mobileSpacing.md,
          alignItems: "center",
          borderRadius: mobileRadii.pill,
        },
        buttonLabel: { color: colors.accent, fontWeight: "500" },
        problem: { color: colors.danger },
      }),
    [colors],
  );

  if (spokes.length === 0 && reading === undefined && !busy) return null;

  return (
    <View style={styles.panel} testID="mobile-owner-alerts">
      <Text style={styles.title}>Owner alerts</Text>
      <Text style={styles.help}>
        A computer raises an alert when a newer roster adds a member. If you did not add it, tap
        Remove, then check the hub. Every action asks for your unlock first.
      </Text>
      {busy ? <ActivityIndicator color={colors.accent} /> : null}
      {notice === undefined ? null : (
        <Text style={notice.tone === "problem" ? styles.problem : styles.body}>
          {notice.message}
        </Text>
      )}
      {reading?.unanswered.length ? (
        <Text style={styles.help}>No answer from {reading.unanswered.join(", ")}.</Text>
      ) : null}
      {reading !== undefined && reading.rows.length === 0 && !busy ? (
        <Text style={styles.body} testID="mobile-owner-alerts-empty">
          No new members to look at.
        </Text>
      ) : null}
      {reading?.rows.map((row) => (
        <View
          key={`${row.spoke.memberId}:${String(row.member.memberId)}`}
          style={styles.box}
          testID="mobile-owner-alert"
        >
          <Text style={styles.boxTitle}>
            {row.member.name} joined {row.spoke.name}
          </Text>
          <Text style={styles.mono} selectable>
            {row.member.identityKeyFingerprint}
          </Text>
          <View style={styles.actions}>
            {(["remove", "confirm", "dismiss"] as const)
              .filter((action) => (action === "confirm" ? row.held : row.alert !== undefined))
              .map((action) => (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  key={action}
                  onPress={() => void act(row, action)}
                  style={styles.button}
                  testID={`mobile-owner-alert-${action}`}
                >
                  <Text style={styles.buttonLabel}>{ACTION_LABEL[action]}</Text>
                </Pressable>
              ))}
          </View>
        </View>
      ))}
    </View>
  );
}
