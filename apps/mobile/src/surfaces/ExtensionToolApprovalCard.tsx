import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  decideMobileExtensionToolApproval,
  listMobileExtensionToolApprovals,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { useTheme } from "../../design-system";
import { ApprovalDecisionButtons } from "../approvals/ApprovalDecisionButtons";
import { MOBILE_COPY } from "../copy";
import { usePolledResource } from "../runtime/usePolledResource";
import {
  decideWithConfirmation,
  type BiometricAuthenticator,
  type ConfirmedSendResult,
} from "../security/BiometricGate";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { OutsideContentNote } from "./OutsideContentNote";
import { mobileSpacing, mobileTypography } from "../theme/tokens";

const INPUT_LINES = 6;

export interface ExtensionToolApprovalCardProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly refreshIntervalMs?: number;
  /** Confirms Allow on this phone; the device's own biometrics when absent. */
  readonly authenticator?: BiometricAuthenticator;
}

/**
 * An MCP tool call this phone's turn made waits on the host until someone
 * answers it, here or at a local window that may drive the thread. The host
 * says what approving covers, and the card offers exactly that, as the
 * desktop card does: every tool of the server (or this tool alone), the
 * server for the rest of a thread that has read outside content, or this one
 * call. The phone never decides what is kept; a host that keeps nothing for
 * this turn says `call`, and the card is then Allow and Deny.
 */
export function ExtensionToolApprovalCard(props: ExtensionToolApprovalCardProps) {
  const { colors } = useTheme();
  const deviceAuthenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const authenticator = props.authenticator ?? deviceAuthenticator;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<string>();
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(
    () =>
      listMobileExtensionToolApprovals({ transport: props.transport, threadId: props.threadId }),
    [props.transport, props.threadId],
  );
  // A waiting call holds the turn, so the prompt is read often while the
  // phone is in front of someone and not at all from a pocket.
  const resource = usePolledResource(load, { intervalMs: props.refreshIntervalMs ?? 2_000 });

  const pending = resource.value?.[0];
  if (pending === undefined) return null;

  const covers = pending.answerCovers ?? "call";
  const decide = async (decision: "approved" | "denied", narrowToTool = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const send = () =>
        decideMobileExtensionToolApproval({
          transport: props.transport,
          approvalId: String(pending.approvalId),
          decision,
          ...(narrowToTool ? { remember: true } : {}),
        });
      // Denying is the safe direction, so only Allow asks for confirmation.
      const outcome: ConfirmedSendResult<Awaited<ReturnType<typeof send>>> =
        decision === "denied"
          ? { status: "sent", value: await send() }
          : await decideWithConfirmation({ authenticator, reason: "approve", send });
      // A refusal means the prompt was answered elsewhere, ran out, or the
      // thread no longer stands; the next read shows which prompts remain.
      setNote(
        outcome.status === "blocked"
          ? outcome.message
          : outcome.value === "accepted"
            ? undefined
            : "The host did not take that answer.",
      );
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    } finally {
      busyRef.current = false;
      setBusy(false);
      void resource.reload();
    }
  };

  const input = pending.inputJson === "" ? "(empty input)" : pending.inputJson;
  // The clamp hides lines the host sent; offer the rest only when there is a rest.
  const clamped = input.split("\n").length > INPUT_LINES || input.length > INPUT_LINES * 40;

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
        numberOfLines={expanded ? undefined : INPUT_LINES}
        style={[mobileTypography.caption, { color: colors.textSecondary }]}
        testID="mobile-extension-tool-approval-input"
      >
        {input}
      </Text>
      {clamped ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => setExpanded((open) => !open)}
          testID="mobile-extension-tool-approval-show-all"
        >
          <Text style={[mobileTypography.caption, { color: colors.textPrimary }]}>
            {expanded ? MOBILE_COPY.approvalShowLess : MOBILE_COPY.approvalShowAll}
          </Text>
        </Pressable>
      ) : null}
      {pending.outsideContent === undefined ? null : (
        <OutsideContentNote outsideContent={pending.outsideContent} />
      )}
      {covers === "call" ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {covers === "server"
            ? MOBILE_COPY.toolApprovalServerDetail
            : MOBILE_COPY.toolApprovalServerOnThreadDetail}
        </Text>
      )}
      <ApprovalDecisionButtons
        allowLabel={
          covers === "server"
            ? MOBILE_COPY.toolApprovalAllowServer
            : covers === "server-on-thread"
              ? MOBILE_COPY.toolApprovalAllowServerOnThread
              : undefined
        }
        busy={busy}
        narrower={
          covers === "server"
            ? {
                label: MOBILE_COPY.toolApprovalAllowToolOnly,
                onPress: () => void decide("approved", true),
              }
            : undefined
        }
        onAllow={() => void decide("approved")}
        onDeny={() => void decide("denied")}
      />
      {resource.error === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {MOBILE_COPY.approvalReconnecting}
        </Text>
      )}
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
});
