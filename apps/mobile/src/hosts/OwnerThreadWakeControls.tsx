import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { OwnerThreadWake, OwnerThreadWakeSwitch } from "@octant/contracts";
import {
  OWNER_THREAD_WAKE_LABELS,
  changeOwnerThreadWake,
  ownerThreadWakeNotice,
  readOwnerThreadWake,
  type OwnerSpoke,
} from "@octant/client-runtime";
import { useTheme } from "../../design-system/theme";
import { space as mobileSpacing } from "../../design-system/tokens";

/**
 * One Code thread's wake switches on the phone, read and changed through the
 * owner routes (docs/design/coordinator-threads.md#talking-to-workers). Each
 * change asks for its own fresh unlock against the reading shown, and the
 * reading is dropped after any answer. The coordinator role is not here. The
 * caller remounts this per host and thread.
 */
export function OwnerThreadWakeControls(props: {
  readonly client: OwnerSpoke["client"];
  readonly threadId: string;
}) {
  const { colors } = useTheme();
  const [wake, setWake] = useState<OwnerThreadWake>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const read = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setWake(undefined);
    setMessage("");
    const result = await readOwnerThreadWake(props.client, props.threadId);
    if (result.status === "read") setWake(result.wake);
    else setMessage(result.message);
    inFlight.current = false;
    setBusy(false);
  };
  const change = async (wakeSwitch: OwnerThreadWakeSwitch, next: boolean) => {
    if (wake === undefined || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const result = await changeOwnerThreadWake(props.client, wake, wakeSwitch, next);
    setWake(undefined);
    setMessage(
      ownerThreadWakeNotice(
        result,
        `${OWNER_THREAD_WAKE_LABELS[wakeSwitch]} is ${next ? "on" : "off"}. Read the switches again to see the current state.`,
      ).message,
    );
    inFlight.current = false;
    setBusy(false);
  };
  const button = (key: string, label: string, act: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={act}
      style={{
        padding: mobileSpacing.md,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: mobileSpacing.sm,
        opacity: busy ? 0.5 : 1,
      }}
    >
      <Text style={{ color: colors.textPrimary }}>{label}</Text>
    </Pressable>
  );
  const row = (wakeSwitch: OwnerThreadWakeSwitch, on: boolean) => (
    <View key={wakeSwitch} style={{ gap: mobileSpacing.sm }}>
      <Text style={{ color: colors.textPrimary }}>
        {OWNER_THREAD_WAKE_LABELS[wakeSwitch]}: {on ? "On" : "Off"}
      </Text>
      {button(
        `wake:${wakeSwitch}`,
        `${on ? "Turn off" : "Turn on"} ${OWNER_THREAD_WAKE_LABELS[wakeSwitch]}`,
        () => void change(wakeSwitch, !on),
      )}
    </View>
  );
  return (
    <View style={{ gap: mobileSpacing.sm }} testID="mobile-owner-thread-wake">
      <Text style={{ color: colors.textSecondary }}>
        Wake switches let other threads start turns on this one while nobody is watching. Each
        change asks for its own fresh unlock.
      </Text>
      {button("wake:read", "Read wake switches", () => void read())}
      {wake === undefined ? null : row("message-wake", wake.messageWake)}
      {wake?.coordinatorWake === undefined ? null : row("coordinator-wake", wake.coordinatorWake)}
      {message === "" ? null : (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>
          {message}
        </Text>
      )}
    </View>
  );
}
