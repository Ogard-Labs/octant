import { useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { OwnerApprovalTarget } from "@octant/contracts/owner-approvals";
import {
  readOwnerApprovals,
  answerOwnerApproval,
  ownerActionNotice,
  type OwnerSpoke,
} from "@octant/client-runtime";
import { useTheme } from "../../design-system/theme";
import { space } from "../../design-system/tokens";

export function OwnerApprovalPanel({ spokes }: { readonly spokes: ReadonlyArray<OwnerSpoke> }) {
  const { colors } = useTheme();
  const [hostId, setHostId] = useState(spokes[0]?.memberId ?? "");
  const host = spokes.find((entry) => entry.memberId === hostId) ?? spokes[0];
  const [targets, setTargets] = useState<ReadonlyArray<OwnerApprovalTarget>>([]);
  const [selected, setSelected] = useState<OwnerApprovalTarget>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const reset = () => {
    setTargets([]);
    setSelected(undefined);
  };
  useLayoutEffect(() => {
    generation.current += 1;
    reset();
    setBusy(false);
    setMessage("");
    return () => {
      generation.current += 1;
    };
  }, [host?.memberId, host?.client, host?.openAt]);
  const load = async () => {
    if (host === undefined || busy || host.openAt !== undefined) return;
    const operation = ++generation.current;
    setBusy(true);
    reset();
    setMessage("");
    const result = await readOwnerApprovals(host.client);
    if (operation !== generation.current) return;
    if (result.status === "read") {
      setTargets(result.reading.targets);
      setMessage(
        result.reading.unavailable > 0
          ? `${result.reading.unavailable} waiting request(s) unavailable: complete supported file-action details are required. Shell, credentials, Browser, publishing and Git administration stay excluded. Answer those prompts in their thread on the host.`
          : result.reading.targets.length === 0
            ? "No recoverable approvals are waiting on this host."
            : "Read the entire action before answering.",
      );
    } else setMessage(result.message);
    setBusy(false);
  };
  const answer = async (approved: boolean) => {
    if (host === undefined || selected === undefined || busy || host.openAt !== undefined) return;
    const operation = ++generation.current;
    setBusy(true);
    const result = await answerOwnerApproval(host.client, selected, approved);
    if (operation !== generation.current) return;
    reset();
    const status =
      result.status === "done" &&
      typeof result.body === "object" &&
      result.body !== null &&
      "status" in result.body
        ? result.body.status
        : undefined;
    setMessage(
      status === "uncertain"
        ? "The answer may have reached the runtime. It will not be retried. Check the thread on its host."
        : ownerActionNotice(
            result,
            "Answer delivered once. Refresh to read any remaining approvals.",
          ).message,
    );
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
        padding: space.md,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: space.sm,
        opacity: busy ? 0.5 : 1,
      }}
    >
      <Text style={{ color: colors.textPrimary }}>{label}</Text>
    </Pressable>
  );
  if (host === undefined) return null;
  return (
    <View style={{ gap: space.sm }} testID="mobile-owner-approval-recovery">
      <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>Owner approval recovery</Text>
      <Text style={{ color: colors.textSecondary }}>
        One Code or Work file action only. Reading private details needs an unlock, which then
        covers Allow once and Deny for five minutes unless that computer asks for an unlock per
        answer. Nothing is remembered.
      </Text>
      <Text style={{ color: colors.textPrimary }}>Computer: {host.name}</Text>
      {spokes.map((entry) =>
        button(`host:${entry.memberId}`, entry.name, () => setHostId(entry.memberId)),
      )}
      {host.openAt === undefined ? (
        <>
          {button("read", "Unlock and read approvals", () => void load())}
          {targets.map((entry) =>
            button(
              String(entry.requestId),
              `${entry.mode === "code" ? "Code" : "Work"}: ${entry.title} — ${entry.action.tool}`,
              () => setSelected(entry),
            ),
          )}
          {selected === undefined ? null : (
            <>
              <Text selectable style={{ color: colors.textPrimary }}>
                Runs on {host.name} · {selected.mode} · {selected.projectName} · {selected.title}
              </Text>
              <Text selectable style={{ color: colors.textPrimary }}>
                Action: {selected.action.tool}
                {selected.action.workingDirectory === undefined
                  ? ""
                  : ` · Working folder: ${selected.action.workingDirectory}`}
              </Text>
              <Text selectable style={{ color: colors.textPrimary }}>
                {JSON.stringify(JSON.parse(selected.action.input), null, 2)}
              </Text>
              {button("allow", "Allow once", () => void answer(true))}
              {button("deny", "Deny", () => void answer(false))}
            </>
          )}
        </>
      ) : (
        <Text style={{ color: colors.textSecondary }}>
          Open {host.name} on this device to recover approvals.
        </Text>
      )}
      <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>
        {busy ? "Waiting for this host and your unlock…" : message}
      </Text>
    </View>
  );
}
