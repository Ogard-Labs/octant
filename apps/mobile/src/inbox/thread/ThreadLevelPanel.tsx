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
  type MobileThreadLevelChange,
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

export interface LevelChoicesProps {
  readonly testID: string;
  /** What the level belongs to, as the heading names it. */
  readonly title: string;
  /** Absent for a Project that follows the default. */
  readonly current: PermissionMode | undefined;
  readonly choices: ReadonlyArray<PermissionMode>;
  readonly hostId: string;
  /** Set where no level is a choice of its own: a Project returning to the default. */
  readonly withoutLevelLabel?: string;
  readonly onPick: (level: PermissionMode | undefined) => Promise<MobileThreadLevelChange>;
  readonly onChanged: () => void;
}

/**
 * One level and the modes it can change to. A pick goes straight to the host
 * as a window's does, after the one-time Full access warning and with no
 * owner unlock.
 */
export function LevelChoices(props: LevelChoicesProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string>();

  const apply = async (level: PermissionMode | undefined) => {
    setBusy(true);
    setConfirming(false);
    setMessage(undefined);
    const result = await props.onPick(level);
    setBusy(false);
    if (result.status === "changed") props.onChanged();
    else setMessage(result.message);
  };
  const choose = (level: PermissionMode) => {
    if (level === "full-access" && !warnedHosts.has(props.hostId)) {
      setConfirming(true);
      return;
    }
    void apply(level);
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

  return (
    <View style={{ gap: mobileSpacing.sm }} testID={props.testID}>
      <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>
        {`${props.title}: ${
          props.current === undefined
            ? (props.withoutLevelLabel ?? "")
            : MOBILE_THREAD_LEVEL_LABELS[props.current]
        }`}
      </Text>
      {confirming ? (
        <>
          <Text style={{ color: colors.textSecondary }}>{MOBILE_FULL_ACCESS_WARNING}</Text>
          {button("confirm", "Use Full access", () => {
            warnedHosts.add(props.hostId);
            void apply("full-access");
          })}
          {button("cancel", "Cancel", () => setConfirming(false))}
        </>
      ) : (
        <>
          {props.choices
            .filter((level) => level !== props.current)
            .map((level) => button(level, MOBILE_THREAD_LEVEL_LABELS[level], () => choose(level)))}
          {props.withoutLevelLabel === undefined || props.current === undefined
            ? null
            : button("without-level", props.withoutLevelLabel, () => void apply(undefined))}
        </>
      )}
      {message === undefined ? null : (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>
          {message}
        </Text>
      )}
    </View>
  );
}

/**
 * The mode a Work or Code thread runs in, set from a phone the host's own
 * person paired. The owner recovery panel remains for a hub's named owners,
 * whose device is not a person-paired one.
 */
export function ThreadLevelPanel(props: ThreadLevelPanelProps) {
  if (!props.actsAsHostPerson) return null;
  const { subject, transport } = props;
  return (
    <LevelChoices
      choices={mobileThreadLevelChoices(subject.mode)}
      current={mobileThreadLevel(subject)}
      hostId={transport.hostId}
      onChanged={props.onChanged}
      onPick={async (level) =>
        level === undefined
          ? { status: "refused", message: "A thread always has a mode." }
          : changeMobileThreadLevel({ transport, subject, level })
      }
      testID="mobile-thread-level"
      title="Mode"
    />
  );
}
