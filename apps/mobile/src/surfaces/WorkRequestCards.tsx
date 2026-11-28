import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  answerMobileWorkQuestion,
  dismissMobileWorkQuestion,
  listMobileWorkRequests,
  resolveMobileWorkApproval,
  type MobileRemoteTransport,
  type MobileWorkRequestAnswer,
} from "@octant/client-runtime";
import type { WorkRequest } from "@octant/contracts";
import { useTheme } from "../../design-system";
import { ApprovalDecisionButtons } from "../approvals/ApprovalDecisionButtons";
import type { LevelChangePresentation } from "../approvals/levelChangePresentation";
import {
  forgetSettledQuestionnaireDrafts,
  questionnaireDraftKey,
} from "../approvals/questionnaireDraft";
import { pendingWorkRequestsInOrder, workRequestCard } from "../approvals/workRequestPresentation";
import { MOBILE_COPY } from "../copy";
import { usePolledResource } from "../runtime/usePolledResource";
import {
  decideWithConfirmation,
  type BiometricAuthenticator,
  type ConfirmedSendResult,
} from "../security/BiometricGate";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import { QuestionnaireCard, type QuestionCardAsk } from "./QuestionnaireCard";

/** The plan scrolls inside the card past this height so the answers stay in reach. */
const PLAN_MAX_HEIGHT = 288;

function workDraftScope(transport: MobileRemoteTransport, threadId: string): string {
  return questionnaireDraftKey(transport.hostId, "work", threadId);
}

function workDraftKey(
  transport: MobileRemoteTransport,
  request: Pick<WorkRequest, "threadId" | "requestId">,
): string {
  return questionnaireDraftKey(
    workDraftScope(transport, String(request.threadId)),
    String(request.requestId),
  );
}

export interface WorkRequestCardsProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly projectId: string;
  readonly watchingOnly?: boolean;
  readonly refreshIntervalMs?: number;
  /** Confirms an approval on this phone; the device's own biometrics when absent. */
  readonly authenticator?: BiometricAuthenticator;
}

/**
 * Everything a Work thread's agent is waiting on a person for, as the desktop
 * draws it: the Plan block for a level change, the provider approval for a
 * tool call, and the provider question, one question or a questionnaire. The
 * phone reads the thread's pending requests from the host and sends only the
 * answer and the version it read; the host applies it and journals it as
 * this device. A Chat or Code thread's questions come through
 * `PendingQuestionCards`.
 */
export function WorkRequestCards(props: WorkRequestCardsProps) {
  const { colors } = useTheme();
  const deviceAuthenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const authenticator = props.authenticator ?? deviceAuthenticator;
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
  const requests = pendingWorkRequestsInOrder(resource.value ?? []);
  const loaded = resource.value !== undefined;
  const waitingKeys = requests.map((request) => workDraftKey(props.transport, request)).join("\n");
  // A request no longer waiting takes its unsent answers with it.
  useEffect(() => {
    if (!loaded) return;
    forgetSettledQuestionnaireDrafts(
      workDraftScope(props.transport, props.threadId),
      waitingKeys === "" ? [] : waitingKeys.split("\n"),
    );
  }, [loaded, waitingKeys, props.transport, props.threadId]);
  if (requests.length === 0) return null;

  return (
    <>
      {requests.map((request) => (
        <WorkRequestCard
          authenticator={authenticator}
          key={String(request.requestId)}
          onSettled={() => void resource.reload()}
          request={request}
          transport={props.transport}
          watchingOnly={props.watchingOnly === true}
        />
      ))}
      {resource.error === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {MOBILE_COPY.approvalReconnecting}
        </Text>
      )}
    </>
  );
}

interface CardProps {
  readonly transport: MobileRemoteTransport;
  readonly request: WorkRequest;
  readonly authenticator: BiometricAuthenticator;
  readonly onSettled: () => void;
  readonly watchingOnly: boolean;
}

/**
 * One answer in flight at a time per card. A refusal shows the host's own
 * sentence and keeps the card, so the person reads why their answer did not
 * go; a lost reply says to check the connection.
 */
function useWorkAnswer(onSettled: () => void, watchingOnly: boolean) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<string>();
  const run = async (send: () => Promise<ConfirmedSendResult<MobileWorkRequestAnswer>>) => {
    if (watchingOnly || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const outcome = await send();
      setNote(
        outcome.status === "blocked"
          ? outcome.message
          : outcome.value.status === "refused"
            ? outcome.value.message
            : undefined,
      );
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    } finally {
      busyRef.current = false;
      setBusy(false);
      onSettled();
    }
  };
  return { busy, note, run };
}

const unconfirmed = async (
  send: () => Promise<MobileWorkRequestAnswer>,
): Promise<ConfirmedSendResult<MobileWorkRequestAnswer>> => ({
  status: "sent",
  value: await send(),
});

function WorkRequestCard(props: CardProps) {
  const card = workRequestCard(props.request);
  if (card === undefined) return null;
  switch (card.kind) {
    case "level-change":
      return <LevelChangeCard {...props} shown={card.shown} />;
    case "tool-approval":
      return <ToolApprovalCard {...props} label={card.label} summary={card.summary} />;
    case "question":
      return (
        <WorkQuestionCard
          {...props}
          ask={{ kind: "plain", prompt: card.prompt, options: card.options }}
          prompt={card.prompt}
        />
      );
    case "questionnaire":
      return (
        <WorkQuestionCard
          {...props}
          ask={{ kind: "questionnaire", questionnaire: card.questionnaire }}
          prompt={card.prompt}
        />
      );
  }
}

function CardNote(props: { readonly note: string | undefined }) {
  const { colors } = useTheme();
  if (props.note === undefined) return null;
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={[mobileTypography.caption, { color: colors.textSecondary }]}
      testID="mobile-work-request-note"
    >
      {props.note}
    </Text>
  );
}

function LevelChangeCard(props: CardProps & { readonly shown: LevelChangePresentation }) {
  const { colors } = useTheme();
  const { busy, note, run } = useWorkAnswer(props.onSettled, props.watchingOnly);
  const { shown } = props;
  const decide = (approved: boolean) => {
    const send = () =>
      resolveMobileWorkApproval({ transport: props.transport, request: props.request, approved });
    // Leaving Plan widens what the next turn may do, so only that answer asks
    // for the phone's confirmation; entering Plan and keeping the level are
    // the safe direction.
    void run(() =>
      approved && !shown.entering
        ? decideWithConfirmation({ authenticator: props.authenticator, reason: "approve", send })
        : unconfirmed(send),
    );
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
      {props.watchingOnly ? null : (
        <ApprovalDecisionButtons
          allowLabel={shown.approveLabel}
          busy={busy}
          denyLabel={shown.keepLabel}
          onAllow={() => decide(true)}
          onDeny={() => decide(false)}
        />
      )}
      <CardNote note={note} />
    </View>
  );
}

/**
 * A provider's ask to run a tool, with the desktop card's words. Approving
 * lets the agent act, so it asks for the phone's own confirmation (Face ID,
 * Touch ID or passcode) first; denying never does.
 */
function ToolApprovalCard(props: CardProps & { readonly label: string; readonly summary: string }) {
  const { colors } = useTheme();
  const { busy, note, run } = useWorkAnswer(props.onSettled, props.watchingOnly);
  const decide = (approved: boolean) => {
    const send = () =>
      resolveMobileWorkApproval({ transport: props.transport, request: props.request, approved });
    void run(() =>
      approved
        ? decideWithConfirmation({ authenticator: props.authenticator, reason: "approve", send })
        : unconfirmed(send),
    );
  };
  return (
    <View
      accessibilityLabel={props.label}
      style={[styles.card, { borderColor: colors.border }]}
      testID="mobile-work-tool-approval"
    >
      <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>{props.label}</Text>
      <Text selectable style={[mobileTypography.body, { color: colors.textPrimary }]}>
        {props.summary}
      </Text>
      {props.watchingOnly ? null : (
        <ApprovalDecisionButtons
          allowLabel={MOBILE_COPY.workApprovalApprove}
          busy={busy}
          onAllow={() => decide(true)}
          onDeny={() => decide(false)}
        />
      )}
      <CardNote note={note} />
    </View>
  );
}

/**
 * The provider's question, one or a questionnaire, on the shared card. The
 * unsent draft is held per request in memory, so leaving the thread and
 * coming back keeps it. Answering grants nothing, so it asks for no
 * confirmation; Dismiss ends a questionnaire's ask without an answer.
 */
function WorkQuestionCard(
  props: CardProps & { readonly prompt: string; readonly ask: QuestionCardAsk },
) {
  const settle = async (send: () => Promise<MobileWorkRequestAnswer>) => {
    try {
      const outcome = await send();
      return outcome.status === "refused" ? outcome.message : undefined;
    } finally {
      props.onSettled();
    }
  };
  return (
    <QuestionnaireCard
      ask={props.ask}
      draftKey={workDraftKey(props.transport, props.request)}
      onDismiss={
        props.ask.kind === "questionnaire"
          ? () =>
              settle(() =>
                dismissMobileWorkQuestion({ transport: props.transport, request: props.request }),
              )
          : undefined
      }
      onSend={(answer) =>
        settle(() =>
          answerMobileWorkQuestion({
            transport: props.transport,
            request: props.request,
            answer: answer.kind === "plain" ? answer.words : answer.response,
          }),
        )
      }
      testID={props.ask.kind === "plain" ? "mobile-work-question" : "mobile-work-questionnaire"}
      title={props.prompt}
      watchingOnly={props.watchingOnly}
    />
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
