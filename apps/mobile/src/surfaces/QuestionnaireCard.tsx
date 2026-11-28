import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Questionnaire, QuestionnaireResponse } from "@octant/contracts";
import { useTheme, withAlpha } from "../../design-system";
import {
  chooseQuestionnaireOption,
  emptyQuestionnaireDraft,
  forgetQuestionnaireDraft,
  heldQuestionnaireDraft,
  holdQuestionnaireDraft,
  plainAnswerOf,
  plainQuestionnaire,
  questionnaireResponseOf,
  writeQuestionnaireAnswer,
  writtenAnswerTakesOver,
  type QuestionnaireDraft,
} from "../approvals/questionnaireDraft";
import { MOBILE_COPY } from "../copy";
import { Icon } from "../ui/Icon";
import { mobileSpacing, mobileTypography } from "../theme/tokens";

/**
 * What the card answers: a questionnaire, answered with its whole response,
 * or one plain question, answered with the chosen option's words or the
 * person's own.
 */
export type QuestionCardAsk =
  | { readonly kind: "questionnaire"; readonly questionnaire: Questionnaire }
  | { readonly kind: "plain"; readonly prompt: string; readonly options: ReadonlyArray<string> };

/** The answer the card hands its surface to send: a full response, or plain words. */
export type QuestionCardAnswer =
  | { readonly kind: "questionnaire"; readonly response: QuestionnaireResponse }
  | { readonly kind: "plain"; readonly words: string };

/** A questionnaire response is sent as its JSON text wherever the host takes text. */
export function questionCardAnswerText(answer: QuestionCardAnswer): string {
  return answer.kind === "plain" ? answer.words : JSON.stringify(answer.response);
}

export interface QuestionnaireCardProps {
  /** The exact request this card answers; the unsent draft is held under it. */
  readonly draftKey: string;
  /** What the agent needs, as the host titles the ask. */
  readonly title: string;
  readonly ask: QuestionCardAsk;
  /** Who asked, when it is not the thread's own agent (a subagent, say). */
  readonly source?: string | undefined;
  readonly watchingOnly: boolean;
  /**
   * Sends the answer. Resolves to nothing once the host took it, or to the
   * sentence to show when it did not; the draft stays for another try.
   */
  readonly onSend: (answer: QuestionCardAnswer) => Promise<string | undefined>;
  /** Ends the ask without an answer, where the mode offers that. */
  readonly onDismiss?: (() => Promise<string | undefined>) | undefined;
  /** Drawn inside another card, so it takes no outer margin of its own. */
  readonly embedded?: boolean;
  readonly testID?: string;
}

function questionnaireOf(ask: QuestionCardAsk): Questionnaire {
  return ask.kind === "questionnaire"
    ? ask.questionnaire
    : plainQuestionnaire(ask.prompt, ask.options);
}

/**
 * The draft for this exact request and definition, read from and written to
 * the in-memory hold so it survives leaving the screen. A new definition
 * under the same key starts over.
 */
function useHeldDraft(key: string, questionnaire: Questionnaire) {
  const bound = `${key}\n${JSON.stringify(questionnaire)}`;
  const initial = () =>
    heldQuestionnaireDraft(key, questionnaire) ?? emptyQuestionnaireDraft(questionnaire);
  const [state, setState] = useState(() => ({ bound, draft: initial() }));
  const draft = state.bound === bound ? state.draft : initial();
  if (state.bound !== bound) setState({ bound, draft });
  const update = (change: (current: QuestionnaireDraft) => QuestionnaireDraft) => {
    const next = change(draft);
    holdQuestionnaireDraft(key, questionnaire, next);
    setState({ bound, draft: next });
  };
  const reset = () => {
    forgetQuestionnaireDraft(key);
    setState({ bound, draft: emptyQuestionnaireDraft(questionnaire) });
  };
  return { draft, update, reset };
}

/**
 * One card for everything an agent asks at once, on every mode's thread:
 * what it needs, each question under its short header with its options as
 * cards, a field for a written answer under each question, and one Send at
 * the foot that answers them all. Choosing only edits the draft.
 */
export function QuestionnaireCard(props: QuestionnaireCardProps) {
  const { colors } = useTheme();
  const questionnaire = questionnaireOf(props.ask);
  const { draft, update, reset } = useHeldDraft(props.draftKey, questionnaire);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<string>();

  const response = questionnaireResponseOf(questionnaire, draft);
  const answer: QuestionCardAnswer | undefined =
    props.ask.kind === "plain"
      ? (() => {
          const words = plainAnswerOf(props.ask.options, draft);
          return words === undefined ? undefined : { kind: "plain", words };
        })()
      : response === undefined
        ? undefined
        : { kind: "questionnaire", response };

  const act = async (send: () => Promise<string | undefined>, sent: () => void) => {
    if (props.watchingOnly || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const refusal = await send();
      setNote(refusal);
      if (refusal === undefined) sent();
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const several = questionnaire.questions.length > 1;
  const single = questionnaire.questions.length === 1 ? questionnaire.questions[0] : undefined;
  // One question titled by its own prompt says it once.
  const titleRepeatsPrompt = single !== undefined && single.prompt.trim() === props.title.trim();

  return (
    <View
      accessibilityLabel={props.title}
      style={[
        styles.card,
        props.embedded === true ? styles.embedded : null,
        { borderColor: colors.border },
      ]}
      testID={props.testID ?? "mobile-questionnaire"}
    >
      <Text style={[mobileTypography.section, { color: colors.accent }]}>
        {MOBILE_COPY.questionCardEyebrow(questionnaire.questions.length)}
      </Text>
      <Text
        accessibilityRole="header"
        style={[mobileTypography.title, { color: colors.textPrimary }]}
      >
        {props.title}
      </Text>
      {props.source === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {props.source}
        </Text>
      )}
      {questionnaire.questions.map((question, questionIndex) => {
        const entry = draft.answers.find((item) => item.questionId === question.id);
        const written = writtenAnswerTakesOver(draft, question);
        const selected = written ? [] : (entry?.selectedOptionIds ?? []);
        const max =
          question.maxSelections ?? (question.selection === "single" ? 1 : question.options.length);
        const role = question.selection === "single" ? "radio" : "checkbox";
        const name = question.header ?? question.prompt;
        return (
          <View
            key={question.id}
            style={[
              styles.question,
              questionIndex === 0 ? null : { borderTopColor: colors.border, ...styles.divided },
            ]}
          >
            {question.header === undefined ? null : (
              <Text style={[mobileTypography.meta, styles.header, { color: colors.textSecondary }]}>
                {question.header}
              </Text>
            )}
            {titleRepeatsPrompt ? null : (
              <Text style={[mobileTypography.rowLabel, { color: colors.textPrimary }]}>
                {question.prompt}
              </Text>
            )}
            {question.options.length === 0 ? null : (
              <Text style={[mobileTypography.meta, { color: colors.textSecondary }]}>
                {question.selection === "single"
                  ? MOBILE_COPY.workQuestionChooseOne
                  : MOBILE_COPY.workQuestionChooseSeveral(question.minSelections ?? 1, max)}
              </Text>
            )}
            <View
              accessibilityLabel={name}
              accessibilityRole={question.selection === "single" ? "radiogroup" : "list"}
              style={styles.choices}
            >
              {question.options.map((option, optionIndex) => {
                const checked = selected.includes(option.id);
                const atLimit =
                  role === "checkbox" && !checked && selected.length >= max && !written;
                return (
                  <OptionCard
                    checked={checked}
                    description={option.description}
                    disabled={props.watchingOnly || busy || atLimit}
                    key={option.id}
                    label={option.label}
                    number={optionIndex + 1}
                    onPress={() =>
                      update((current) => chooseQuestionnaireOption(current, question, option.id))
                    }
                    recommended={option.recommended === true}
                    role={role}
                  />
                );
              })}
            </View>
            {props.watchingOnly || question.allowCustom === false ? null : (
              <TextInput
                accessibilityHint={
                  question.options.length === 0 ? undefined : MOBILE_COPY.questionWrittenHint
                }
                accessibilityLabel={MOBILE_COPY.questionWrittenLabel(several ? name : undefined)}
                editable={!busy}
                maxLength={2_000}
                multiline
                onChangeText={(text) =>
                  update((current) => writeQuestionnaireAnswer(current, question, text))
                }
                placeholder={MOBILE_COPY.questionWrittenPlaceholder}
                placeholderTextColor={colors.textSecondary}
                style={[
                  styles.input,
                  {
                    color: colors.textPrimary,
                    borderColor: written ? colors.accent : colors.hairlineStrong,
                  },
                ]}
                value={entry?.written ?? ""}
              />
            )}
          </View>
        );
      })}
      {props.watchingOnly || questionnaire.allowComment === false ? null : (
        <TextInput
          accessibilityLabel={MOBILE_COPY.workQuestionComment}
          editable={!busy}
          maxLength={2_000}
          multiline
          onChangeText={(comment) => update((current) => ({ ...current, comment }))}
          placeholder={MOBILE_COPY.workQuestionComment}
          placeholderTextColor={colors.textSecondary}
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.hairlineStrong }]}
          value={draft.comment}
        />
      )}
      {props.watchingOnly ? null : (
        <>
          <Pressable
            accessibilityLabel={
              several ? MOBILE_COPY.workQuestionSendAnswers : MOBILE_COPY.questionSendAnswer
            }
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || answer === undefined, busy }}
            disabled={busy || answer === undefined}
            onPress={() => {
              if (answer === undefined) return;
              void act(() => props.onSend(answer), reset);
            }}
            style={[
              styles.primary,
              {
                backgroundColor: colors.send,
                opacity: busy || answer === undefined ? 0.5 : 1,
              },
            ]}
            testID="mobile-questionnaire-submit"
          >
            <Text style={[mobileTypography.rowLabel, { color: colors.sendLabel }]}>
              {busy
                ? MOBILE_COPY.workQuestionSending
                : several
                  ? MOBILE_COPY.workQuestionSendAnswers
                  : MOBILE_COPY.questionSendAnswer}
            </Text>
          </Pressable>
          {props.onDismiss === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              hitSlop={8}
              onPress={() => {
                const dismiss = props.onDismiss;
                if (dismiss !== undefined) void act(dismiss, reset);
              }}
              style={styles.quiet}
              testID="mobile-questionnaire-dismiss"
            >
              <Text style={[mobileTypography.body, { color: colors.textSecondary }]}>
                {MOBILE_COPY.workQuestionDismiss}
              </Text>
            </Pressable>
          )}
        </>
      )}
      {note === undefined ? null : (
        <Text
          accessibilityLiveRegion="polite"
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID="mobile-questionnaire-note"
        >
          {note}
        </Text>
      )}
    </View>
  );
}

/**
 * One option as a card: its number, its words, what it means, and a quiet
 * pill when the agent recommends it. Chosen reads in the mark's shape as well
 * as its colour, and a screen reader hears the recommendation with the label.
 */
function OptionCard(props: {
  readonly number: number;
  readonly label: string;
  readonly description?: string | undefined;
  readonly recommended: boolean;
  readonly checked: boolean;
  readonly role: "radio" | "checkbox";
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityHint={props.description}
      accessibilityLabel={
        props.recommended ? MOBILE_COPY.questionRecommendedOption(props.label) : props.label
      }
      accessibilityRole={props.role}
      accessibilityState={{ disabled: props.disabled }}
      aria-checked={props.checked}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.option,
        {
          borderColor: props.checked ? colors.accent : colors.hairlineStrong,
          backgroundColor: props.checked ? withAlpha(colors.accent, 0.08) : "transparent",
          opacity: props.disabled && !props.checked ? 0.55 : 1,
        },
      ]}
    >
      <Text
        style={[
          mobileTypography.meta,
          styles.number,
          { color: colors.textSecondary, borderColor: colors.hairlineStrong },
        ]}
      >
        {props.number}
      </Text>
      <View style={styles.optionText}>
        <View style={styles.optionTitle}>
          <Text style={[mobileTypography.rowLabel, styles.label, { color: colors.textPrimary }]}>
            {props.label}
          </Text>
          {props.recommended ? (
            <Text
              style={[
                mobileTypography.meta,
                styles.pill,
                { color: colors.textSecondary, backgroundColor: withAlpha(colors.accent, 0.1) },
              ]}
            >
              {MOBILE_COPY.questionRecommended}
            </Text>
          ) : null}
        </View>
        {props.description === undefined ? null : (
          <Text style={[mobileTypography.detail, { color: colors.textSecondary }]}>
            {props.description}
          </Text>
        )}
      </View>
      <Icon
        color={props.checked ? colors.accent : colors.textTertiary}
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
    </Pressable>
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
  embedded: { marginHorizontal: 0, marginBottom: 0, padding: mobileSpacing.sm },
  question: { gap: mobileSpacing.xs, paddingTop: mobileSpacing.sm },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: mobileSpacing.xs },
  header: { textTransform: "uppercase", letterSpacing: 0.4 },
  choices: { gap: mobileSpacing.xs },
  option: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: mobileSpacing.sm,
    paddingHorizontal: mobileSpacing.sm,
    paddingVertical: mobileSpacing.sm,
    borderWidth: 1,
    borderRadius: 10,
  },
  number: {
    minWidth: 22,
    textAlign: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingVertical: 1,
  },
  optionText: { flex: 1, gap: 2 },
  optionTitle: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  label: { flexShrink: 1 },
  pill: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, overflow: "hidden" },
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
    marginTop: mobileSpacing.sm,
  },
  quiet: { minHeight: 44, alignItems: "center", justifyContent: "center" },
});
