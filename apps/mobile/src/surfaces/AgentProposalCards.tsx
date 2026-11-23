import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  decideMobileMemoryProposal,
  decideMobileRoutineProposal,
  listMobileMemoryProposals,
  listMobileRoutineProposals,
  type MobileProposalAnswer,
  type MobileProposalDecision,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { ProjectMemoryProposal } from "@octant/contracts";
import type { RoutineAgentRequest } from "@octant/contracts/automation";
import { routineScheduleLabel } from "@octant/domain";
import { useTheme } from "../../design-system";
import { ApprovalDecisionButtons } from "../approvals/ApprovalDecisionButtons";
import { MOBILE_COPY } from "../copy";
import { usePolledResource, type PolledResource } from "../runtime/usePolledResource";
import { decideWithConfirmation, type BiometricAuthenticator } from "../security/BiometricGate";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { OutsideContentNote } from "./OutsideContentNote";

export interface AgentProposalCardProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  /**
   * What the host said of this session. The decision routes take an answer
   * only from a device the host's own person paired; any other session is
   * shown the proposal and told to answer it on the computer.
   */
  readonly actsAsHostPerson: boolean;
  readonly refreshIntervalMs?: number;
  /** Confirms a Save or Create on this phone; the device's own biometrics when absent. */
  readonly authenticator?: BiometricAuthenticator;
}

/**
 * A change to Project memory this phone's turn asked for, as the desktop card
 * shows it: exactly what would be written, and nothing changes until Save.
 */
export function MemoryProposalCard(props: AgentProposalCardProps) {
  const { transport, threadId } = props;
  const load = useCallback(
    () => listMobileMemoryProposals({ transport, threadId }),
    [transport, threadId],
  );
  // A waiting proposal holds the turn's tool call, so it is read often while
  // the phone is in front of someone.
  const resource = usePolledResource(load, { intervalMs: props.refreshIntervalMs ?? 2_000 });
  const pending = resource.value?.[0];
  const answer = useProposalAnswer(props, resource, (proposalId, decision) =>
    decideMobileMemoryProposal({ transport, proposalId, decision }),
  );
  const showCard = pending !== undefined && answer.answeredId !== String(pending.proposalId);
  if (!showCard) {
    return answer.failure === undefined ? null : (
      <ProposalFailureNote
        message={answer.failure}
        onDismiss={answer.dismissFailure}
        testID="mobile-memory-proposal-failed"
      />
    );
  }
  const { change } = pending;
  return (
    <>
      {answer.failure === undefined ? null : (
        <ProposalFailureNote
          message={answer.failure}
          onDismiss={answer.dismissFailure}
          testID="mobile-memory-proposal-failed"
        />
      )}
      <ProposalFrame
        allowLabel={change.kind === "retract" ? "Retract" : "Save to memory"}
        answer={answer}
        denyLabel="Decline"
        detail="Every later thread in this Project starts with this memory. It is marked as written by an agent."
        onDecide={(decision) => void answer.decide(String(pending.proposalId), decision)}
        props={props}
        stale={resource.error !== undefined}
        summary={memorySummary(change)}
        testID="mobile-memory-proposal"
      >
        {change.kind === "supersede" ? (
          <ProposalText>Replaces: {change.previousContent}</ProposalText>
        ) : null}
        {change.kind === "retract" ? <ProposalText>Reason: {change.reason}</ProposalText> : null}
        <ProposalText strong>{change.content}</ProposalText>
        {pending.outsideContent === undefined ? null : (
          <OutsideContentNote outsideContent={pending.outsideContent} />
        )}
      </ProposalFrame>
    </>
  );
}

/**
 * A routine this phone's turn proposed, or its request to pause or archive
 * one, as the desktop card shows it: what would run and when, and nothing
 * exists or changes until the person confirms.
 */
export function RoutineProposalCard(props: AgentProposalCardProps) {
  const { transport, threadId } = props;
  const load = useCallback(
    () => listMobileRoutineProposals({ transport, threadId }),
    [transport, threadId],
  );
  const resource = usePolledResource(load, { intervalMs: props.refreshIntervalMs ?? 2_000 });
  const pending = resource.value?.[0];
  const answer = useProposalAnswer(props, resource, (proposalId, decision) =>
    decideMobileRoutineProposal({ transport, proposalId, decision }),
  );
  const showCard = pending !== undefined && answer.answeredId !== String(pending.proposalId);
  if (!showCard) {
    return answer.failure === undefined ? null : (
      <ProposalFailureNote
        message={answer.failure}
        onDismiss={answer.dismissFailure}
        testID="mobile-routine-proposal-failed"
      />
    );
  }
  const words = routineWords(pending);
  return (
    <>
      {answer.failure === undefined ? null : (
        <ProposalFailureNote
          message={answer.failure}
          onDismiss={answer.dismissFailure}
          testID="mobile-routine-proposal-failed"
        />
      )}
      <ProposalFrame
        allowLabel={words.allowLabel}
        answer={answer}
        denyLabel={words.denyLabel}
        detail={words.detail}
        onDecide={(decision) => void answer.decide(String(pending.proposalId), decision)}
        props={props}
        stale={resource.error !== undefined}
        summary={words.summary}
        testID="mobile-routine-proposal"
      >
        <ProposalText strong>{pending.displayName}</ProposalText>
        {words.body === undefined ? null : <ProposalText>{words.body}</ProposalText>}
      </ProposalFrame>
    </>
  );
}

interface ProposalAnswerState {
  readonly busy: boolean;
  readonly note: string | undefined;
  /** The proposal this card answered, hidden until the host's list drops it. */
  readonly answeredId: string | undefined;
  /**
   * A change the host could not apply, said where the card was until the
   * person dismisses it or leaves the screen.
   */
  readonly failure: string | undefined;
  readonly dismissFailure: () => void;
  readonly decide: (proposalId: string, decision: MobileProposalDecision) => Promise<void>;
}

function useProposalAnswer(
  props: AgentProposalCardProps,
  resource: PolledResource<unknown>,
  send: (proposalId: string, decision: MobileProposalDecision) => Promise<MobileProposalAnswer>,
): ProposalAnswerState {
  const deviceAuthenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [note, setNote] = useState<string>();
  const [answeredId, setAnsweredId] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const decide = async (proposalId: string, decision: MobileProposalDecision) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNote(undefined);
    try {
      const deliver = () => send(proposalId, decision);
      // Declining is the safe direction, so only a confirm asks this phone first.
      const outcome =
        decision === "decline"
          ? { status: "sent" as const, value: await deliver() }
          : await decideWithConfirmation({
              authenticator: props.authenticator ?? deviceAuthenticator,
              reason: "approve",
              send: deliver,
            });
      if (outcome.status === "blocked") setNote(outcome.message);
      else if (outcome.value.status === "refused") setNote(MOBILE_COPY.proposalAnswerOnComputer);
      else {
        // Every answer the host took, and a proposal already gone, leaves its
        // list. A confirmed change the host could not apply says why where the
        // card was: withdrawing the card alone would lose the reason.
        setAnsweredId(proposalId);
        if (outcome.value.status === "not-applied") {
          setFailure(MOBILE_COPY.proposalNotSaved(outcome.value.message));
        }
      }
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    } finally {
      inFlight.current = false;
      setBusy(false);
      void resource.reload();
    }
  };
  return { busy, note, answeredId, failure, dismissFailure: () => setFailure(undefined), decide };
}

function ProposalFrame(props: {
  readonly props: AgentProposalCardProps;
  readonly testID: string;
  readonly summary: string;
  readonly detail: string | undefined;
  readonly allowLabel: string;
  readonly denyLabel: string;
  readonly answer: ProposalAnswerState;
  readonly stale: boolean;
  readonly onDecide: (decision: MobileProposalDecision) => void;
  readonly children: ReactNode;
}) {
  const { colors } = useTheme();
  const caption = { ...mobileTypography.caption, color: colors.textSecondary };
  return (
    <View style={[styles.card, { borderColor: colors.border }]} testID={props.testID}>
      <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{props.summary}</Text>
      {props.children}
      {props.detail === undefined ? null : <Text style={caption}>{props.detail}</Text>}
      {props.props.actsAsHostPerson ? (
        <ApprovalDecisionButtons
          allowLabel={props.allowLabel}
          busy={props.answer.busy || props.stale}
          denyLabel={props.denyLabel}
          onAllow={() => props.onDecide("confirm")}
          onDeny={() => props.onDecide("decline")}
        />
      ) : (
        <Text style={caption}>{MOBILE_COPY.proposalAnswerOnComputer}</Text>
      )}
      {props.stale || props.answer.note !== undefined ? (
        <Text accessibilityLiveRegion="polite" style={caption}>
          {props.stale ? MOBILE_COPY.approvalReconnecting : props.answer.note}
        </Text>
      ) : null}
    </View>
  );
}

/** Where a withdrawn card was: why the host saved nothing, until dismissed. */
function ProposalFailureNote(props: {
  readonly message: string;
  readonly onDismiss: () => void;
  readonly testID: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { borderColor: colors.border }]} testID={props.testID}>
      <Text
        accessibilityLiveRegion="polite"
        style={[mobileTypography.body, { color: colors.textPrimary }]}
      >
        {props.message}
      </Text>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={props.onDismiss}
        style={styles.quiet}
        testID={`${props.testID}-dismiss`}
      >
        <Text style={[mobileTypography.body, { color: colors.textSecondary }]}>
          {MOBILE_COPY.proposalFailureDismiss}
        </Text>
      </Pressable>
    </View>
  );
}

function ProposalText(props: { readonly children: ReactNode; readonly strong?: boolean }) {
  const { colors } = useTheme();
  return (
    <Text
      style={[
        mobileTypography.caption,
        { color: props.strong === true ? colors.textPrimary : colors.textSecondary },
      ]}
    >
      {props.children}
    </Text>
  );
}

function memorySummary(change: ProjectMemoryProposal["change"]): string {
  switch (change.kind) {
    case "create":
      return `Save a ${change.memoryKind} to Project memory?`;
    case "supersede":
      return "Replace a Project memory entry?";
    case "retract":
      return "Retract a Project memory entry?";
  }
}

function routineWords(request: RoutineAgentRequest): {
  readonly summary: string;
  readonly body: string | undefined;
  readonly detail: string | undefined;
  readonly allowLabel: string;
  readonly denyLabel: string;
} {
  const followUp = request.targetPolicy === "same-thread";
  if ("kind" in request) {
    const allowLabel =
      request.change === "pause"
        ? "Pause routine"
        : followUp
          ? "Cancel follow-up"
          : "Archive routine";
    return {
      summary: `${allowLabel}? The agent asks.`,
      body: request.reason,
      detail:
        request.change === "pause"
          ? "It stops until you resume it in Automations."
          : followUp
            ? "Its scheduled turn will not be sent."
            : "It stops for good. Its run history stays in Automations.",
      allowLabel,
      denyLabel: "Keep it",
    };
  }
  const firstRunAt = new Date(request.firstRunAt);
  const firstRun = firstRunAt.toLocaleString();
  // A weekly routine repeats in its trigger's zone, which can be a country
  // away from the phone: name it, and name the phone's zone on the first run
  // when it is another zone's clock the time is shown in.
  const scheduleZone =
    request.trigger.kind === "weekly-local"
      ? ` ${shortZoneName(request.trigger.timeZone, firstRunAt)}`
      : "";
  const firstRunZone =
    request.trigger.kind === "weekly-local" &&
    resolvedTimeZone(request.trigger.timeZone) !== resolvedTimeZone(undefined)
      ? ` ${shortZoneName(undefined, firstRunAt)}`
      : "";
  return {
    summary: followUp ? "Schedule a follow-up here?" : "Create this routine?",
    body: request.taskPrompt,
    detail: followUp
      ? `Once, ${firstRun}. It sends this prompt as a new turn in this thread.`
      : `${routineScheduleLabel(request.trigger)}${scheduleZone} · First run ${firstRun}${firstRunZone}. Each run starts a new thread in this Project with this prompt, and asks before it changes anything.`,
    allowLabel: followUp ? "Schedule follow-up" : "Create routine",
    denyLabel: "Decline",
  };
}

/** The zone a clock time is read in, as people see it ("CET", "GMT+1"). */
function shortZoneName(timeZone: string | undefined, at: Date): string {
  const part = new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    timeZoneName: "short",
  })
    .formatToParts(at)
    .find((entry) => entry.type === "timeZoneName");
  return part?.value ?? timeZone ?? "";
}

/** Canonical IANA id, so a routine's zone and the phone's still compare as one. */
function resolvedTimeZone(timeZone: string | undefined): string {
  return new Intl.DateTimeFormat(
    "en-US",
    timeZone === undefined ? {} : { timeZone },
  ).resolvedOptions().timeZone;
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
  quiet: { minHeight: 44, alignItems: "center", justifyContent: "center" },
});
