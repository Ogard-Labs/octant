import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  answerMobileWorkQuestion,
  dismissMobileWorkQuestion,
  listMobileWorkRequests,
  resolveMobileWorkApproval,
  type MobileRemoteTransport,
  type MobileWorkRequestAnswer,
} from "@octant/client-runtime";
import type { Questionnaire, WorkRequest } from "@octant/contracts";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, withAlpha } from "../../design-system";
import { ApprovalDecisionButtons } from "../approvals/ApprovalDecisionButtons";
import type { LevelChangePresentation } from "../approvals/levelChangePresentation";
import {
  chooseQuestionnaireOption,
  emptyQuestionnaireDraft,
  pendingWorkRequestsInOrder,
  questionnaireResponseOf,
  toggleQuestionnaireCustom,
  workRequestCard,
  writeQuestionnaireCustom,
} from "../approvals/workRequestPresentation";
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

export interface WorkRequestCardsProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly projectId: string;
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
 * this device. A Code thread's asks stay with the desktop.
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
}

/**
 * One answer in flight at a time per card. A refusal shows the host's own
 * sentence and keeps the card, so the person reads why their answer did not
 * go; a lost reply says to check the connection.
 */
function useWorkAnswer(onSettled: () => void) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<string>();
  const run = async (send: () => Promise<ConfirmedSendResult<MobileWorkRequestAnswer>>) => {
    if (busyRef.current) return;
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
      return <QuestionCard {...props} options={card.options} prompt={card.prompt} />;
    case "questionnaire":
      return (
        <QuestionnaireCard {...props} prompt={card.prompt} questionnaire={card.questionnaire} />
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
  const { busy, note, run } = useWorkAnswer(props.onSettled);
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
      <ApprovalDecisionButtons
        allowLabel={shown.approveLabel}
        busy={busy}
        denyLabel={shown.keepLabel}
        onAllow={() => decide(true)}
        onDeny={() => decide(false)}
      />
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
  const { busy, note, run } = useWorkAnswer(props.onSettled);
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
      <ApprovalDecisionButtons
        allowLabel={MOBILE_COPY.workApprovalApprove}
        busy={busy}
        onAllow={() => decide(true)}
        onDeny={() => decide(false)}
      />
      <CardNote note={note} />
    </View>
  );
}

function Choice(props: {
  readonly label: string;
  readonly description?: string | undefined;
  readonly checked: boolean;
  readonly role: "radio" | "checkbox";
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={props.role}
      accessibilityState={{ checked: props.checked, disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.choice,
        {
          borderColor: props.checked ? colors.accent : colors.hairlineStrong,
          backgroundColor: props.checked ? withAlpha(colors.accent, 0.1) : "transparent",
          opacity: props.disabled === true ? 0.5 : 1,
        },
      ]}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {/* The mark says chosen in shape as well as colour. */}
      <Ionicons
        color={props.checked ? colors.accent : colors.textSecondary}
        name={
          props.role === "radio"
            ? props.checked
              ? "radio-button-on"
              : "radio-button-off"
            : props.checked
              ? "checkbox"
              : "square-outline"
        }
        size={20}
      />
      <View style={styles.choiceText}>
        <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{props.label}</Text>
        {props.description === undefined ? null : (
          <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
            {props.description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function PrimaryButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.primary, { backgroundColor: colors.send, opacity: props.disabled ? 0.5 : 1 }]}
      testID={props.testID}
    >
      <Text style={[mobileTypography.section, { color: colors.sendLabel }]}>{props.label}</Text>
    </Pressable>
  );
}

const CUSTOM = "octant-question-custom";

/**
 * One question the provider asked and the turn is blocked on: each offered
 * answer, and the person's own words for an answer no option covers.
 * Answering grants nothing, so it asks for no confirmation.
 */
function QuestionCard(
  props: CardProps & { readonly prompt: string; readonly options: ReadonlyArray<string> },
) {
  const { colors } = useTheme();
  const { busy, note, run } = useWorkAnswer(props.onSettled);
  const [selected, setSelected] = useState<string>();
  const [written, setWritten] = useState("");
  const custom = selected === CUSTOM;
  const answer = custom ? written.trim() : (props.options.find((o) => o === selected) ?? "");
  return (
    <View
      accessibilityLabel="Provider question"
      style={[styles.card, { borderColor: colors.border }]}
      testID="mobile-work-question"
    >
      <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{props.prompt}</Text>
      <View accessibilityRole="radiogroup" style={styles.choices}>
        {props.options.map((option) => (
          <Choice
            checked={selected === option}
            key={option}
            label={option}
            onPress={() => setSelected(option)}
            role="radio"
          />
        ))}
        <Choice
          checked={custom}
          label={MOBILE_COPY.workQuestionOwnAnswer}
          onPress={() => setSelected(CUSTOM)}
          role="radio"
        />
        {custom ? (
          <TextInput
            accessibilityLabel={MOBILE_COPY.workQuestionYourAnswer}
            onChangeText={setWritten}
            placeholder={MOBILE_COPY.workQuestionYourAnswerPlaceholder}
            placeholderTextColor={colors.textSecondary}
            style={[
              styles.input,
              { color: colors.textPrimary, borderColor: colors.hairlineStrong },
            ]}
            value={written}
          />
        ) : null}
      </View>
      <PrimaryButton
        disabled={busy || answer.length === 0}
        label={MOBILE_COPY.workQuestionSubmit}
        onPress={() =>
          void run(() =>
            unconfirmed(() =>
              answerMobileWorkQuestion({
                transport: props.transport,
                request: props.request,
                answer,
              }),
            ),
          )
        }
        testID="mobile-work-question-submit"
      />
      <CardNote note={note} />
    </View>
  );
}

/**
 * A provider's questionnaire: every question with its limits, an answer in
 * the person's own words where a question takes one, an optional comment,
 * and Dismiss, which ends the turn's question without an answer.
 */
function QuestionnaireCard(
  props: CardProps & { readonly prompt: string; readonly questionnaire: Questionnaire },
) {
  const { colors } = useTheme();
  const { busy, note, run } = useWorkAnswer(props.onSettled);
  const [draft, setDraft] = useState(() => emptyQuestionnaireDraft(props.questionnaire));
  const response = questionnaireResponseOf(props.questionnaire, draft);
  return (
    <View
      accessibilityLabel="Questionnaire"
      style={[styles.card, { borderColor: colors.border }]}
      testID="mobile-work-questionnaire"
    >
      <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{props.prompt}</Text>
      {props.questionnaire.questions.map((question) => {
        const answer = draft.answers.find((entry) => entry.questionId === question.id);
        const selected = answer?.selectedOptionIds ?? [];
        const custom = draft.customIds.includes(question.id);
        const max = question.maxSelections ?? question.options.length;
        const role = question.selection === "single" ? "radio" : "checkbox";
        return (
          <View key={question.id} style={styles.question}>
            <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>
              {question.prompt}
            </Text>
            <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
              {question.selection === "single"
                ? MOBILE_COPY.workQuestionChooseOne
                : MOBILE_COPY.workQuestionChooseSeveral(question.minSelections ?? 1, max)}
            </Text>
            <View
              accessibilityLabel={question.prompt}
              accessibilityRole={question.selection === "single" ? "radiogroup" : undefined}
              style={styles.choices}
            >
              {question.options.map((option) => {
                const checked = !custom && selected.includes(option.id);
                return (
                  <Choice
                    checked={checked}
                    description={option.description}
                    disabled={
                      busy || (role === "checkbox" && !checked && !custom && selected.length >= max)
                    }
                    key={option.id}
                    label={`${option.label}${option.recommended === true ? " (Recommended)" : ""}`}
                    onPress={() =>
                      setDraft((current) => chooseQuestionnaireOption(current, question, option.id))
                    }
                    role={role}
                  />
                );
              })}
              {question.allowCustom === false ? null : (
                <Choice
                  checked={custom}
                  disabled={busy}
                  label={MOBILE_COPY.workQuestionWriteAnother}
                  onPress={() =>
                    setDraft((current) => toggleQuestionnaireCustom(current, question))
                  }
                  role={role}
                />
              )}
              {custom ? (
                <TextInput
                  accessibilityLabel={MOBILE_COPY.workQuestionYourAnswer}
                  maxLength={2_000}
                  multiline
                  onChangeText={(text) =>
                    setDraft((current) => writeQuestionnaireCustom(current, question, text))
                  }
                  placeholderTextColor={colors.textSecondary}
                  style={[
                    styles.input,
                    { color: colors.textPrimary, borderColor: colors.hairlineStrong },
                  ]}
                  value={answer?.customAnswer ?? ""}
                />
              ) : null}
            </View>
          </View>
        );
      })}
      {props.questionnaire.allowComment === false ? null : (
        <TextInput
          accessibilityLabel={MOBILE_COPY.workQuestionComment}
          maxLength={2_000}
          multiline
          onChangeText={(comment) => setDraft((current) => ({ ...current, comment }))}
          placeholder={MOBILE_COPY.workQuestionComment}
          placeholderTextColor={colors.textSecondary}
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.hairlineStrong }]}
          value={draft.comment}
        />
      )}
      <PrimaryButton
        disabled={busy || response === undefined}
        label={busy ? MOBILE_COPY.workQuestionSending : MOBILE_COPY.workQuestionSendAnswers}
        onPress={() => {
          if (response === undefined) return;
          void run(() =>
            unconfirmed(() =>
              answerMobileWorkQuestion({
                transport: props.transport,
                request: props.request,
                answer: response,
              }),
            ),
          );
        }}
        testID="mobile-work-questionnaire-submit"
      />
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        hitSlop={8}
        onPress={() =>
          void run(() =>
            unconfirmed(() =>
              dismissMobileWorkQuestion({ transport: props.transport, request: props.request }),
            ),
          )
        }
        style={styles.quiet}
        testID="mobile-work-questionnaire-dismiss"
      >
        <Text style={[mobileTypography.body, { color: colors.textSecondary }]}>
          {MOBILE_COPY.workQuestionDismiss}
        </Text>
      </Pressable>
      <CardNote note={note} />
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
  question: { gap: mobileSpacing.xs, marginTop: mobileSpacing.xs },
  choices: { gap: mobileSpacing.xs },
  choice: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: mobileSpacing.sm,
    paddingHorizontal: mobileSpacing.sm,
    paddingVertical: mobileSpacing.xs,
    borderWidth: 1,
    borderRadius: 10,
  },
  choiceText: { flex: 1, gap: 2 },
  input: {
    minHeight: 44,
    paddingHorizontal: mobileSpacing.sm,
    paddingVertical: mobileSpacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    marginTop: mobileSpacing.xs,
  },
  quiet: { minHeight: 44, alignItems: "center", justifyContent: "center" },
});
