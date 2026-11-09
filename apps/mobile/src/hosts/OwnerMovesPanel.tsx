import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  ownerActionNotice,
  type OwnerActionNotice,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import { mobilePinnedListenerTransport } from "../runtime/mobilePinnedListenerTransport";
import { usePolledResource } from "../runtime/usePolledResource";
import { useTheme } from "../../design-system";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import type { GuestHubStore } from "./hubGuestFlow";
import { phoneThreadMovesOf, type PhoneHeldMove } from "./ownerFlow";
import type { PhoneUnlockKey } from "./ownerUnlockKey";

export interface OwnerMovesPanelProps {
  readonly guestHubStore: GuestHubStore;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly unlockKey: PhoneUnlockKey;
}

/**
 * How often an open panel asks the computers what waits. A computer holds a
 * move for only five minutes, and the person usually starts it at the desk
 * with this screen already open, so a read made only when the panel mounted
 * would miss it.
 */
const WAITING_MOVES_POLL_MS = 5_000;

/**
 * Thread moves a computer's window holds until this phone confirms them. A
 * move is an owner act on the destination, so Confirm asks for the unlock and
 * the destination issues the ticket only after it; nothing moves without it.
 * The panel is mounted only while the Computers screen shows, so it polls only
 * then, and only while the app is in front.
 */
export function OwnerMovesPanel(props: OwnerMovesPanelProps) {
  const { colors } = useTheme();
  const [notice, setNotice] = useState<OwnerActionNotice>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const state = await props.guestHubStore.load();
    const found =
      state === undefined
        ? undefined
        : await phoneThreadMovesOf({
            state,
            deviceKeyStore: props.deviceKeyStore,
            transport: mobilePinnedListenerTransport,
            unlockKey: props.unlockKey,
          });
    return { moves: found, reading: await found?.read() };
  }, [props.deviceKeyStore, props.guestHubStore, props.unlockKey]);
  const waiting = usePolledResource(load, { intervalMs: WAITING_MOVES_POLL_MS });
  const moves = waiting.value?.moves;
  const held = waiting.value?.reading?.moves ?? [];
  const unanswered = waiting.value?.reading?.unanswered ?? [];

  const confirm = async (move: PhoneHeldMove) => {
    if (moves === undefined) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await moves.confirm(move);
      setNotice(
        ownerActionNotice(
          result,
          `Confirmed. ${move.source.name} is moving it to ${move.confirmation.destinationName}.`,
        ),
      );
    } catch {
      setNotice({ tone: "problem", message: "Nothing moved. Try again." });
    } finally {
      setBusy(false);
    }
    await waiting.reload();
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
        button: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.accent,
          paddingVertical: mobileSpacing.sm,
          paddingHorizontal: mobileSpacing.md,
          alignItems: "center",
          alignSelf: "flex-start",
          borderRadius: mobileRadii.pill,
        },
        buttonLabel: { color: colors.accent, fontWeight: "500" },
        problem: { color: colors.danger },
      }),
    [colors],
  );

  if (moves === undefined || (held.length === 0 && notice === undefined)) return null;

  return (
    <View style={styles.panel} testID="mobile-owner-moves">
      <Text style={styles.title}>Moves waiting for you</Text>
      <Text style={styles.help}>
        A computer you are leaving asked this phone to confirm moving threads. The thread is erased
        there once the other computer has it. Confirm asks for your unlock first.
      </Text>
      {busy ? <ActivityIndicator color={colors.accent} /> : null}
      {notice === undefined ? null : (
        <Text style={notice.tone === "problem" ? styles.problem : styles.body}>
          {notice.message}
        </Text>
      )}
      {unanswered.length > 0 ? (
        <Text style={styles.help}>No answer from {unanswered.join(", ")}.</Text>
      ) : null}
      {held.map((move) => (
        <View
          key={`${move.source.memberId}:${move.confirmation.confirmationId}`}
          style={styles.box}
          testID="mobile-owner-move"
        >
          <Text style={styles.boxTitle}>
            {move.confirmation.threads.length === 1
              ? `Move “${move.confirmation.threads[0]?.title ?? "a thread"}”`
              : `Move ${move.confirmation.threads.length} threads`}{" "}
            from {move.source.name} to {move.confirmation.destinationName}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void confirm(move)}
            style={styles.button}
            testID="mobile-owner-move-confirm"
          >
            <Text style={styles.buttonLabel}>Confirm move</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
