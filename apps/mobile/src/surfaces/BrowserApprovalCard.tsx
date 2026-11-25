import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  decideMobileBrowserApproval,
  listMobileBrowserApprovals,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { usePolledResource } from "../runtime/usePolledResource";
import {
  decideWithConfirmation,
  type BiometricAuthenticator,
  type ConfirmedSendResult,
} from "../security/BiometricGate";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import {
  browserApprovalNote,
  browserApprovalView,
  type BrowserApprovalAnswer,
} from "./browserApprovalPresentation";

export interface BrowserApprovalCardProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  /** What the host said of this session; absent reads as restricted. */
  readonly actsAsHostPerson?: boolean;
  readonly watchingOnly?: boolean;
  readonly refreshIntervalMs?: number;
  /** Confirms an approving answer on this phone; the device's own biometrics when absent. */
  readonly authenticator?: BiometricAuthenticator;
}

/**
 * A Browser prompt the agent's turn raised waits on the host until someone
 * answers it, here or at a window or another device that may drive the thread:
 * a site, an upload or a download, a sign-in, a script, or a page's own tool.
 * The first answer settles it. The card shows what the desktop card shows (the
 * site, the profile, the direction and the files, the agent's reason) and
 * offers the answers the host keeps for this session, so a restricted session
 * is never offered "Always allow". When another client answered first, or the
 * prompt ran out, or the host refuses, the card says so plainly.
 */
export function BrowserApprovalCard(props: BrowserApprovalCardProps) {
  const { colors } = useTheme();
  const deviceAuthenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const authenticator = props.authenticator ?? deviceAuthenticator;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<string>();

  const load = useCallback(
    () => listMobileBrowserApprovals({ transport: props.transport, threadId: props.threadId }),
    [props.transport, props.threadId],
  );
  // A waiting prompt holds the turn, so it is read often while the phone is in
  // front of someone and not at all from a pocket.
  const resource = usePolledResource(load, { intervalMs: props.refreshIntervalMs ?? 2_000 });

  const pending = resource.value?.[0];
  if (pending === undefined) {
    return note === undefined ? null : (
      <Text
        accessibilityLiveRegion="polite"
        style={[
          mobileTypography.caption,
          { color: colors.textSecondary, marginHorizontal: mobileSpacing.md },
        ]}
        testID="mobile-browser-approval-note"
      >
        {note}
      </Text>
    );
  }

  const view = browserApprovalView(pending, { actsAsHostPerson: props.actsAsHostPerson === true });
  const decide = async (answer: BrowserApprovalAnswer) => {
    if (props.watchingOnly === true || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNote(undefined);
    try {
      const send = () =>
        decideMobileBrowserApproval({
          transport: props.transport,
          decision: { approvalId: pending.approvalId, ...answer.decision },
        });
      // Denying is the safe direction, so only an approving answer asks the
      // phone for confirmation.
      const outcome: ConfirmedSendResult<Awaited<ReturnType<typeof send>>> =
        answer.decision.decision === "denied"
          ? { status: "sent", value: await send() }
          : await decideWithConfirmation({ authenticator, reason: "approve", send });
      setNote(
        outcome.status === "blocked" ? outcome.message : browserApprovalNote(outcome.value, view),
      );
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    } finally {
      busyRef.current = false;
      setBusy(false);
      void resource.reload();
    }
  };

  return (
    <View style={[styles.card, { borderColor: colors.border }]} testID="mobile-browser-approval">
      <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>{view.label}</Text>
      <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{view.summary}</Text>
      <Text
        style={[mobileTypography.caption, { color: colors.textSecondary }]}
        testID="mobile-browser-approval-facts"
      >
        Site: {view.site}. Profile: {view.profile}.
        {view.direction === undefined
          ? ""
          : ` ${view.direction === "upload" ? "Upload" : "Download"}.`}
      </Text>
      {view.files.map((file) => (
        <Text
          key={file}
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID="mobile-browser-approval-file"
        >
          {file}
        </Text>
      ))}
      {view.reason === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          Reason: {view.reason}
        </Text>
      )}
      {view.context === undefined ? null : (
        <Text
          numberOfLines={6}
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID="mobile-browser-approval-context"
        >
          {view.context}
        </Text>
      )}
      <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>{view.detail}</Text>
      {props.watchingOnly === true ? null : (
        <View style={styles.answers} testID="mobile-browser-approval-answers">
          {view.answers.map((answer) => (
            <Pressable
              accessibilityLabel={answer.label}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy, busy }}
              disabled={busy}
              key={answer.id}
              onPress={() => void decide(answer)}
              style={[
                styles.button,
                answer.id === "once"
                  ? { backgroundColor: colors.send }
                  : { borderColor: colors.textSecondary, borderWidth: 1 },
                busy ? styles.busy : null,
              ]}
              testID={`mobile-browser-approval-${answer.id}`}
            >
              <Text
                style={[
                  mobileTypography.section,
                  { color: answer.id === "once" ? colors.sendLabel : colors.textPrimary },
                ]}
              >
                {answer.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {resource.error === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {MOBILE_COPY.approvalReconnecting}
        </Text>
      )}
      {note === undefined ? null : (
        <Text
          accessibilityLiveRegion="polite"
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID="mobile-browser-approval-note"
        >
          {note}
        </Text>
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
  answers: { gap: mobileSpacing.sm, marginTop: mobileSpacing.xs },
  button: {
    minHeight: 44,
    borderRadius: 10,
    paddingVertical: mobileSpacing.sm,
    paddingHorizontal: mobileSpacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  busy: { opacity: 0.45 },
});
