import { useCallback, useEffect, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import {
  decideMobileExtensionToolApproval,
  listMobileExtensionToolApprovals,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { ExtensionToolApproval } from "@octant/contracts/extension-rpc";
import { GlassChip, useTheme } from "../../design-system";
import { OutsideContentNote } from "./OutsideContentNote";
import { mobileSpacing, mobileTypography } from "../theme/tokens";

export interface ExtensionToolApprovalCardProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly refreshIntervalMs?: number;
}

/**
 * An MCP tool call this phone's turn made waits on the host until someone
 * answers it, here or at a local window that may drive the thread. The phone
 * offers Approve once and Deny only: "always allow in this Project" is a local
 * window's answer, and the host refuses it from a paired device.
 */
export function ExtensionToolApprovalCard(props: ExtensionToolApprovalCardProps) {
  const { colors } = useTheme();
  const [approvals, setApprovals] = useState<ReadonlyArray<ExtensionToolApproval>>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();

  const load = useCallback(async () => {
    try {
      setApprovals(
        await listMobileExtensionToolApprovals({
          transport: props.transport,
          threadId: props.threadId,
        }),
      );
    } catch {
      setApprovals([]);
    }
  }, [props.transport, props.threadId]);

  useEffect(() => {
    void load();
    // A waiting call holds the turn, so the prompt is read often while the
    // phone is in front of someone and not at all from a pocket.
    const interval = setInterval(() => {
      if (AppState.currentState === "active") void load();
    }, props.refreshIntervalMs ?? 2_000);
    return () => clearInterval(interval);
  }, [load, props.refreshIntervalMs]);

  const pending = approvals[0];
  if (pending === undefined) return null;

  const decide = (decision: "approved" | "denied") => {
    if (busy) return;
    setBusy(true);
    void decideMobileExtensionToolApproval({
      transport: props.transport,
      approvalId: String(pending.approvalId),
      decision,
    })
      .then((result) => {
        // A refusal means the prompt was answered elsewhere, ran out, or the
        // thread no longer stands; the next read shows which prompts remain.
        setNote(result === "accepted" ? undefined : "The host did not take that answer.");
      })
      .catch(() => setNote("The answer could not be sent. Try again."))
      .finally(() => {
        setBusy(false);
        void load();
      });
  };

  return (
    <View
      style={[styles.card, { borderColor: colors.border }]}
      testID="mobile-extension-tool-approval"
    >
      <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>
        Allow {pending.mcpToolName}?
      </Text>
      <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
        Server: {pending.serverName}.
      </Text>
      <Text
        numberOfLines={6}
        style={[mobileTypography.caption, { color: colors.textSecondary }]}
        testID="mobile-extension-tool-approval-input"
      >
        {pending.inputJson === "" ? "(empty input)" : pending.inputJson}
      </Text>
      {pending.outsideContent === undefined ? null : (
        <OutsideContentNote outsideContent={pending.outsideContent} />
      )}
      <View style={styles.chips}>
        <GlassChip active={false} label="Approve once" onPress={() => decide("approved")} />
        <GlassChip active={false} label="Deny" onPress={() => decide("denied")} />
      </View>
      {note === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>{note}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: mobileSpacing.md,
    marginBottom: mobileSpacing.sm,
    padding: mobileSpacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    gap: mobileSpacing.xs,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: mobileSpacing.xs,
    marginTop: mobileSpacing.xs,
  },
});
