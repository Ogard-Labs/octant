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
  /** What the host said of this session; absent reads as restricted. */
  readonly actsAsHostPerson?: boolean;
  readonly refreshIntervalMs?: number;
  /** Confirms Allow on this phone; the device's own biometrics when absent. */
  readonly authenticator?: BiometricAuthenticator;
}

/**
 * An MCP tool call this phone's turn made waits on the host until someone
 * answers it, here or at a local window that may drive the thread. Allow
 * covers this one call. "Always allow in this Project" is offered as a window
 * offers it: for a prompt the host marked rememberable, to a session that
 * acts as the host's own person. The host refuses it from any other session,
 * which is offered Allow and Deny only.
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

  const canRemember = pending.rememberable && props.actsAsHostPerson === true;
  const decide = async (decision: "approved" | "denied", remember?: true) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const send = () =>
        decideMobileExtensionToolApproval({
          transport: props.transport,
          approvalId: String(pending.approvalId),
          decision,
          ...(remember === undefined ? {} : { remember }),
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
      <ApprovalDecisionButtons
        busy={busy}
        onAllow={() => void decide("approved")}
        onAllowProject={canRemember ? () => void decide("approved", true) : undefined}
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
