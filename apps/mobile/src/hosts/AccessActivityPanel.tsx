import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { readRemoteSessionStanding, type MobileRemoteTransport } from "@octant/client-runtime";
import { createMobileAccessActivityClient } from "@octant/client-runtime/access-activity-client";
import type {
  AccessActivityList,
  ChangeNotice,
  ChangeNoticeList,
} from "@octant/contracts/access-activity";
import { useTheme } from "../../design-system";
import { usePolledResource } from "../runtime/usePolledResource";
import { decideWithConfirmation, type BiometricAuthenticator } from "../security/BiometricGate";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import {
  ACCESS_ACTIVITY_EMPTY,
  accessActorPhrase,
  changeNoticeActions,
  describeAccessEntry,
  describeChangeNotice,
  relativeTimeLabel,
} from "./accessActivityPresentation";

/** The phone is in someone's hand while this is open, so it is read often; a pocket reads nothing. */
const REFRESH_MS = 15_000;
/** Shown before "Show more", so a long history does not push the settings below it. */
const VISIBLE_ENTRIES = 8;

export interface AccessActivityPanelProps {
  readonly transport: MobileRemoteTransport | undefined;
  /** Override standing in tests; live callers read it from the host session. */
  readonly actsAsHostPerson?: boolean;
  readonly refreshIntervalMs?: number;
  /** Confirms a revoke on this phone; the device's own biometrics when absent. */
  readonly authenticator?: BiometricAuthenticator;
}

interface Reading {
  readonly activity: AccessActivityList;
  readonly notices: ChangeNoticeList;
}

/**
 * Who changed access to one paired computer, and the notices that a paired
 * device or an agent raised a thread's level or changed a provider key
 * (maintainer decision, 2026-11-22). In the app only: no notice is pushed.
 * The host decides what this phone sees (a device paired at Full, other than
 * the one that made the change) and what each action may do; the panel shows
 * nothing for any other session and shows the host's words when it refuses.
 */
export function AccessActivityPanel(props: AccessActivityPanelProps) {
  const { colors } = useTheme();
  const { transport } = props;
  const [person, setPerson] = useState(props.actsAsHostPerson === true);

  useEffect(() => {
    if (transport === undefined) {
      setPerson(false);
      return;
    }
    if (props.actsAsHostPerson !== undefined) {
      setPerson(props.actsAsHostPerson);
      return;
    }
    let cancelled = false;
    void readRemoteSessionStanding(transport).then(
      (standing) => {
        if (!cancelled) setPerson(standing.actsAsHostPerson);
      },
      () => {
        if (!cancelled) setPerson(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [transport, props.actsAsHostPerson]);

  const client = useMemo(
    () => (transport === undefined ? undefined : createMobileAccessActivityClient(transport)),
    [transport],
  );
  const load = useCallback(async (): Promise<Reading> => {
    if (client === undefined) throw new Error("No connection.");
    const [activity, notices] = await Promise.all([client.readActivity(), client.readNotices()]);
    // A refused or unreadable answer keeps what was last shown.
    if (activity === undefined || notices === undefined) throw new Error("Not readable.");
    return { activity, notices };
  }, [client]);
  const resource = usePolledResource(load, {
    intervalMs: props.refreshIntervalMs ?? REFRESH_MS,
    enabled: person && client !== undefined,
  });

  const deviceAuthenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const authenticator = props.authenticator ?? deviceAuthenticator;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [refusal, setRefusal] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [showAll, setShowAll] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: { gap: mobileSpacing.sm, marginTop: mobileSpacing.lg },
        title: { ...mobileTypography.title, color: colors.textPrimary },
        help: { ...mobileTypography.caption, color: colors.textSecondary },
        box: {
          gap: mobileSpacing.xs,
          padding: mobileSpacing.md,
          backgroundColor: colors.surface,
          borderRadius: mobileRadii.md,
        },
        boxTitle: { ...mobileTypography.body, color: colors.textPrimary, fontWeight: "500" },
        actions: { flexDirection: "row", flexWrap: "wrap", gap: mobileSpacing.sm },
        button: {
          paddingVertical: mobileSpacing.sm,
          paddingHorizontal: mobileSpacing.md,
          borderRadius: mobileRadii.md,
          borderWidth: 1,
          borderColor: colors.border,
          minHeight: 44,
          justifyContent: "center",
        },
        danger: { backgroundColor: colors.danger, borderColor: colors.danger },
        buttonLabel: { ...mobileTypography.body, color: colors.textPrimary },
        dangerLabel: { ...mobileTypography.body, color: colors.sendLabel, fontWeight: "500" },
        disabled: { opacity: 0.45 },
      }),
    [colors],
  );

  if (!person || client === undefined) return null;

  const run = async (
    action: "undo" | "dismiss" | "revoke",
    notice: ChangeNotice,
  ): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setRefusal(undefined);
    setConfirming(undefined);
    try {
      // Revoking takes access from a device or an agent, so it asks the phone's
      // own biometrics first; Undo and Dismiss change nothing the person could
      // not set right again.
      const send = () => client.act(action, notice.noticeId);
      const outcome =
        action === "revoke"
          ? await decideWithConfirmation({ authenticator, reason: "revoke", send })
          : { status: "sent" as const, value: await send() };
      if (outcome.status === "blocked") setRefusal(outcome.message);
      else if (outcome.value.status === "refused") setRefusal(outcome.value.message);
    } catch {
      setRefusal("Couldn't send that. Check the connection and try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      void resource.reload();
    }
  };

  const reading = resource.value;
  const entries = reading?.activity.entries ?? [];
  const shown = showAll ? entries : entries.slice(0, VISIBLE_ENTRIES);

  return (
    <View style={styles.panel} testID="mobile-access-activity">
      <Text accessibilityRole="header" style={styles.title}>
        Access activity
      </Text>
      {reading === undefined && resource.error === undefined ? (
        <View accessibilityLabel="Reading access activity" testID="mobile-access-activity-loading">
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : null}
      {reading === undefined && resource.error !== undefined ? (
        <Text style={styles.help} testID="mobile-access-activity-error">
          Access activity could not be read.
        </Text>
      ) : null}
      {reading !== undefined && resource.error !== undefined ? (
        <Text style={styles.help}>Reconnecting…</Text>
      ) : null}
      {refusal === undefined ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.help} testID="mobile-access-refusal">
          {refusal}
        </Text>
      )}
      {reading?.notices.notices.map((notice) => {
        const description = describeChangeNotice(notice);
        const actions = changeNoticeActions(notice);
        const asking = confirming === notice.noticeId;
        return (
          <View key={notice.noticeId} style={styles.box} testID="mobile-change-notice">
            <Text style={styles.boxTitle}>{description}</Text>
            <Text style={styles.help}>
              {relativeTimeLabel(notice.at)}
              {actions.noUndoReason === undefined ? "" : ` · ${actions.noUndoReason}`}
            </Text>
            {asking ? (
              <>
                <Text style={styles.boxTitle}>{actions.revokeTitle}</Text>
                <Text style={styles.help}>{actions.revokeConsequence}</Text>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityLabel={actions.revokeConfirmLabel}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy, busy }}
                    disabled={busy}
                    onPress={() => void run("revoke", notice)}
                    style={[styles.button, styles.danger, busy ? styles.disabled : null]}
                    testID="mobile-change-notice-revoke-confirm"
                  >
                    <Text style={styles.dangerLabel}>{actions.revokeConfirmLabel}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel="Keep it"
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => setConfirming(undefined)}
                    style={styles.button}
                    testID="mobile-change-notice-revoke-cancel"
                  >
                    <Text style={styles.buttonLabel}>Keep it</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <View style={styles.actions}>
                {actions.undo ? (
                  <Pressable
                    accessibilityLabel={`Undo: ${description}`}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy, busy }}
                    disabled={busy}
                    onPress={() => void run("undo", notice)}
                    style={[styles.button, busy ? styles.disabled : null]}
                    testID="mobile-change-notice-undo"
                  >
                    <Text style={styles.buttonLabel}>Undo</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityLabel={actions.revokeLabel}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy, busy }}
                  disabled={busy}
                  onPress={() => setConfirming(notice.noticeId)}
                  style={[styles.button, busy ? styles.disabled : null]}
                  testID="mobile-change-notice-revoke"
                >
                  <Text style={styles.buttonLabel}>{actions.revokeLabel}</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={`Dismiss: ${description}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy, busy }}
                  disabled={busy}
                  onPress={() => void run("dismiss", notice)}
                  style={[styles.button, busy ? styles.disabled : null]}
                  testID="mobile-change-notice-dismiss"
                >
                  <Text style={styles.buttonLabel}>Dismiss</Text>
                </Pressable>
              </View>
            )}
          </View>
        );
      })}
      {reading !== undefined && entries.length === 0 ? (
        <Text style={styles.help} testID="mobile-access-activity-empty">
          {ACCESS_ACTIVITY_EMPTY}
        </Text>
      ) : null}
      {shown.map((entry) => (
        <View
          accessible
          key={entry.entryId}
          style={styles.box}
          testID="mobile-access-activity-entry"
        >
          <Text style={styles.boxTitle}>{describeAccessEntry(entry)}</Text>
          <Text style={styles.help}>
            {accessActorPhrase(entry.actor)} · {relativeTimeLabel(entry.at)}
          </Text>
        </View>
      ))}
      {entries.length > VISIBLE_ENTRIES ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => setShowAll((open) => !open)}
          testID="mobile-access-activity-more"
        >
          <Text style={[mobileTypography.caption, { color: colors.textPrimary }]}>
            {showAll ? "Show fewer" : `Show all ${entries.length}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
