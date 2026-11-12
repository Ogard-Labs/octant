import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PermissionMode } from "@octant/contracts";
import {
  changeMobileThreadLevel,
  mobileThreadLevel,
  mobileThreadLevelChoices,
  MOBILE_FULL_ACCESS_WARNING,
  MOBILE_THREAD_LEVEL_LABELS,
  type MobileRemoteTransport,
  type MobileThreadLevelSubject,
} from "@octant/client-runtime";
import { useTheme } from "../../../design-system/theme";
import { space as mobileSpacing } from "../../../design-system/tokens";

export interface ThreadLevelPanelProps {
  /** What the host said of this session; a restricted session is shown nothing. */
  readonly actsAsHostPerson: boolean;
  readonly subject: MobileThreadLevelSubject;
  readonly transport: MobileRemoteTransport;
  /** The host took a change; the caller reads the thread again. */
  readonly onChanged: () => void;
}

/**
 * The hosts whose Full access warning this phone has shown since it started.
 * Kept for the app's run only, so the warning comes back after a restart:
 * the phone has no settings store of its own here, and showing it again is
 * the safe side.
 */
const warnedHosts = new Set<string>();

/**
 * The mode a Work or Code thread runs in, set from a phone the host's own
 * person paired. It goes straight to the host as a window's pick does, after
 * the Full access warning and with no owner unlock. The owner recovery panel
 * remains for a hub's named owners, whose device is not a person-paired one.
 */
export function ThreadLevelPanel(props: ThreadLevelPanelProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string>();
  if (!props.actsAsHostPerson) return null;

  const current = mobileThreadLevel(props.subject);
  const apply = async (level: PermissionMode) => {
    setBusy(true);
    setConfirming(false);
    setMessage(undefined);
    const result = await changeMobileThreadLevel({
      transport: props.transport,
      subject: props.subject,
      level,
    });
    setBusy(false);
    if (result.status === "changed") props.onChanged();
    else setMessage(result.message);
  };
  const choose = (level: PermissionMode) => {
    if (level === "full-access" && !warnedHosts.has(props.transport.hostId)) {
      setConfirming(true);
      return;
    }
    void apply(level);
  };
  const button = (key: string, label: string, act: () => void, chosen = false) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, selected: chosen }}
      disabled={busy}
      onPress={act}
      style={{
        padding: mobileSpacing.md,
        borderWidth: 1,
        borderColor: chosen ? colors.accent : colors.border,
        borderRadius: mobileSpacing.sm,
        opacity: busy ? 0.5 : 1,
      }}
    >
      <Text style={{ color: colors.textPrimary }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ gap: mobileSpacing.sm }} testID="mobile-thread-level">
      <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>
        Mode: {MOBILE_THREAD_LEVEL_LABELS[current]}
      </Text>
      {confirming ? (
        <>
          <Text style={{ color: colors.textSecondary }}>{MOBILE_FULL_ACCESS_WARNING}</Text>
          {button("confirm", "Use Full access", () => {
            warnedHosts.add(props.transport.hostId);
            void apply("full-access");
          })}
          {button("cancel", "Cancel", () => setConfirming(false))}
        </>
      ) : (
        mobileThreadLevelChoices(props.subject.mode)
          .filter((level) => level !== current)
          .map((level) => button(level, MOBILE_THREAD_LEVEL_LABELS[level], () => choose(level)))
      )}
      {message === undefined ? null : (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>
          {message}
        </Text>
      )}
    </View>
  );
}
