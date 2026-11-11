import { useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { OwnerPostureTarget, OwnerPosture } from "@octant/contracts";
import {
  readOwnerPostures,
  changeOwnerPosture,
  ownerActionNotice,
  ownerPostureLabel,
  ownerPostureLevels,
  type OwnerSpoke,
} from "@octant/client-runtime";
import { useTheme } from "../../design-system/theme";
import { space as mobileSpacing } from "../../design-system/tokens";
import { OwnerThreadWakeControls } from "./OwnerThreadWakeControls";

export function OwnerPosturePanel({ spokes }: { readonly spokes: ReadonlyArray<OwnerSpoke> }) {
  const { colors } = useTheme();
  const [hostId, setHostId] = useState(spokes[0]?.memberId ?? "");
  const [targets, setTargets] = useState<ReadonlyArray<OwnerPostureTarget>>([]);
  const [selected, setSelected] = useState<OwnerPostureTarget>();
  const [requested, setRequested] = useState<OwnerPosture["posture"]>("approval-gated");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const host = spokes.find((entry) => entry.memberId === hostId) ?? spokes[0];
  const generation = useRef(0);
  // Replacing a member or its client invalidates readings and pending UI results.
  useLayoutEffect(() => {
    generation.current += 1;
    setHostId(host?.memberId ?? "");
    setTargets([]);
    setSelected(undefined);
    setMessage("");
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [host?.memberId, host?.client, host?.openAt]);
  const reset = () => {
    setTargets([]);
    setSelected(undefined);
  };
  const load = async () => {
    if (host === undefined || busy) return;
    const operation = ++generation.current;
    setBusy(true);
    reset();
    setMessage("");
    const result = await readOwnerPostures(host.client);
    if (operation !== generation.current) return;
    if (result.status === "read") {
      setTargets(result.targets);
      setMessage(
        result.targets.length === 0
          ? "No active Work or Code targets on this host."
          : "Choose a Work or Code target.",
      );
    } else setMessage(result.message);
    setBusy(false);
  };
  const apply = async () => {
    if (host === undefined || selected === undefined || busy) return;
    const operation = ++generation.current;
    setBusy(true);
    const result = await changeOwnerPosture(host.client, selected.posture, requested);
    if (operation !== generation.current) return;
    reset();
    setMessage(
      ownerActionNotice(result, "Level changed. Refresh to read the current level.").message,
    );
    setBusy(false);
  };
  const button = (
    key: string,
    label: string,
    act: () => void,
    chosen = false,
    disabled = false,
  ) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy || disabled, selected: chosen }}
      disabled={busy || disabled}
      onPress={act}
      style={{
        padding: mobileSpacing.md,
        borderWidth: 1,
        borderColor: chosen ? colors.accent : colors.border,
        borderRadius: mobileSpacing.sm,
        opacity: busy || disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: colors.textPrimary }}>{label}</Text>
    </Pressable>
  );
  if (spokes.length === 0) return null;
  return (
    <View style={{ gap: mobileSpacing.sm }} testID="mobile-owner-code-recovery">
      <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>Owner access recovery</Text>
      <Text style={{ color: colors.textSecondary }}>
        Full access needs a fresh unlock for this choice. Running turns keep their level.
      </Text>
      <Text style={{ color: colors.textPrimary }}>Computer: {host?.name}</Text>
      {spokes.map((spoke) =>
        button(
          `host:${spoke.memberId}`,
          spoke.name,
          () => {
            setHostId(spoke.memberId);
            reset();
            setMessage("");
          },
          host?.memberId === spoke.memberId,
        ),
      )}
      {button("refresh", "Refresh access levels", () => void load())}
      {targets.map((target) =>
        button(
          `target:${JSON.stringify(target.posture.subject)}`,
          `${target.posture.subject.kind === "project" ? "Project" : target.posture.subject.kind === "work-thread" ? "Work thread" : "Thread"}: ${target.title}`,
          () => {
            setSelected(target);
            setRequested(target.posture.posture);
            setMessage("");
          },
          selected === target,
        ),
      )}
      {selected === undefined ? null : (
        <>
          <Text style={{ color: colors.textPrimary }}>
            Current level: {ownerPostureLabel(selected.posture)}
          </Text>
          <Text style={{ color: colors.textPrimary }}>
            Requested level: {ownerPostureLabel(selected.posture, requested)}
          </Text>
          {ownerPostureLevels(selected.posture).map((policy) =>
            button(
              `policy:${policy}`,
              ownerPostureLabel(selected.posture, policy),
              () => setRequested(policy),
              requested === policy,
            ),
          )}
          {button(
            "apply",
            "Apply level",
            () => void apply(),
            false,
            requested === selected.posture.posture,
          )}
          {selected.posture.subject.kind === "code-thread" && host !== undefined ? (
            <OwnerThreadWakeControls
              key={`${host.memberId}:${String(selected.posture.subject.threadId)}`}
              client={host.client}
              threadId={String(selected.posture.subject.threadId)}
            />
          ) : null}
        </>
      )}
      <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>
        {busy ? "Waiting for this host and your unlock…" : message}
      </Text>
    </View>
  );
}
