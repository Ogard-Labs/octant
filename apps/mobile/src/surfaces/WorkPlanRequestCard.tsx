import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  listMobileWorkRequests,
  resolveMobileWorkApproval,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { useTheme } from "../../design-system";
import { ApprovalDecisionButtons } from "../approvals/ApprovalDecisionButtons";
import { levelChangePresentation } from "../approvals/levelChangePresentation";
import { MOBILE_COPY } from "../copy";
import { usePolledResource } from "../runtime/usePolledResource";
import {
  decideWithConfirmation,
  type BiometricAuthenticator,
  type ConfirmedSendResult,
} from "../security/BiometricGate";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";

/** The plan scrolls inside the card past this height so the answers stay in reach. */
const PLAN_MAX_HEIGHT = 288;

export interface WorkPlanRequestCardProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly projectId: string;
  readonly refreshIntervalMs?: number;
  /** Confirms an approved plan on this phone; the device's own biometrics when absent. */
  readonly authenticator?: BiometricAuthenticator;
}

/**
 * The Work agent's own ask to plan first, or to leave Plan with a plan, as
 * the desktop's Plan block draws it: the sentence, the plan whole in a
 * bordered monospace block, what happens to this turn, and the two answers.
 * The host applies the level change and journals it as this device.
 */
export function WorkPlanRequestCard(props: WorkPlanRequestCardProps) {
  const { colors } = useTheme();
  const deviceAuthenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const authenticator = props.authenticator ?? deviceAuthenticator;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<string>();

  const load = useCallback(
    () =>
      listMobileWorkRequests(props.transport, {
        threadId: props.threadId,
        projectId: props.projectId,
      }),
    [props.transport, props.threadId, props.projectId],
  );
  // A waiting ask holds the turn, so it is read often while the screen is open.
  const resource = usePolledResource(load, { intervalMs: props.refreshIntervalMs ?? 2_000 });

  const request = resource.value?.find(
    (candidate) => levelChangePresentation(candidate) !== undefined,
  );
  const shown = request === undefined ? undefined : levelChangePresentation(request);
  if (request === undefined || shown === undefined) return null;

  const decide = async (approved: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const send = () =>
        resolveMobileWorkApproval({ transport: props.transport, request, approved });
      // Leaving Plan widens what the next turn may do, so only that answer
      // asks for the phone's confirmation; entering Plan and keeping the
      // level are the safe direction.
      const outcome: ConfirmedSendResult<Awaited<ReturnType<typeof send>>> =
        approved && !shown.entering
          ? await decideWithConfirmation({ authenticator, reason: "approve", send })
          : { status: "sent", value: await send() };
      setNote(outcome.status === "blocked" ? outcome.message : undefined);
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    } finally {
      busyRef.current = false;
      setBusy(false);
      void resource.reload();
    }
  };

  return (
    <View
      accessibilityLabel={shown.label}
      style={[styles.card, { borderColor: colors.border }]}
      testID="mobile-work-plan-request"
    >
      <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>{shown.label}</Text>
      <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{shown.summary}</Text>
      {shown.plan === undefined ? null : (
        <ScrollView
          accessibilityLabel="Proposed plan"
          nestedScrollEnabled
          style={[styles.plan, { borderColor: colors.border }]}
          testID="mobile-work-plan-request-plan"
        >
          <Text selectable style={[mobileTypography.mono, { color: colors.textPrimary }]}>
            {shown.plan}
          </Text>
        </ScrollView>
      )}
      <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
        {shown.detail}
      </Text>
      <ApprovalDecisionButtons
        allowLabel={shown.approveLabel}
        busy={busy}
        denyLabel={shown.keepLabel}
        onAllow={() => void decide(true)}
        onDeny={() => void decide(false)}
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
  plan: {
    maxHeight: PLAN_MAX_HEIGHT,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: mobileRadii.bubble,
    padding: mobileSpacing.sm,
  },
});
