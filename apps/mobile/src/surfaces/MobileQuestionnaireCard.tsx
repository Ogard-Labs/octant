import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Questionnaire, QuestionnaireResponse } from "@octant/contracts";
import { useTheme, withAlpha } from "../../design-system";
import {
  chooseQuestionnaireOption,
  questionnaireResponseOf,
  writeQuestionnaireCustom,
  type QuestionnaireDraft,
} from "../approvals/workRequestPresentation";
import { MOBILE_COPY } from "../copy";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { Icon } from "../ui/Icon";
import {
  clearMobileQuestionnaireDraft,
  questionnaireDefinitionKey,
  readMobileQuestionnaireDraft,
  writeMobileQuestionnaireDraft,
} from "./questionnaireDraftStore";

export interface MobileChoiceProps {
  readonly label: string;
  readonly description?: string | undefined;
  readonly recommended?: boolean | undefined;
  readonly checked: boolean;
  readonly role: "radio" | "checkbox";
  readonly disabled?: boolean | undefined;
  readonly onPress: () => void;
  readonly testID?: string | undefined;
}

export function MobileChoice(props: MobileChoiceProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={props.role}
      accessibilityState={{ checked: props.checked, disabled: props.disabled === true }}
      aria-checked={props.checked}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.choice,
        {
          borderColor: props.checked ? colors.accent : colors.hairlineStrong,
          backgroundColor: props.checked ? withAlpha(colors.accent, 0.14) : "transparent",
          opacity: props.disabled === true ? 0.5 : 1,
        },
      ]}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {/* The mark says chosen in shape as well as colour. */}
      <Icon
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
        <View style={styles.choiceLabelRow}>
          <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{props.label}</Text>
          {props.recommended === true ? (
            <View
              style={[
                styles.recommendedPill,
                {
                  borderColor: colors.hairlineStrong,
                  backgroundColor: withAlpha(colors.textSecondary, 0.08),
                },
              ]}
            >
              <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
                {" Recommended"}
              </Text>
            </View>
          ) : null}
        </View>
        {props.description === undefined ? null : (
          <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
            {props.description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export function MobilePrimaryButton(props: {
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

export interface MobileQuestionnaireCardProps {
  /** Stable key so unsent drafts survive leaving the thread screen. */
  readonly draftKey?: string | undefined;
  readonly prompt: string;
  readonly questionnaire: Questionnaire;
  readonly subtitle?: string | undefined;
  readonly watchingOnly?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly note?: string | undefined;
  /** Return true when the host accepted the answer so the draft is cleared. */
  readonly onSubmit: (response: QuestionnaireResponse) => boolean | Promise<boolean>;
  readonly onDismiss?: (() => void) | undefined;
  readonly testID?: string | undefined;
  readonly submitTestID?: string | undefined;
  readonly dismissTestID?: string | undefined;
  readonly noteTestID?: string | undefined;
  /** When embedded inside a parent card (e.g. native harness panel), omit outer horizontal margins. */
  readonly embedded?: boolean | undefined;
}

/**
 * Shared mobile questionnaire card used across Work, native harness, Chat, and
 * Code threads: one card heading, per-question headers, option descriptions,
 * quiet Recommended pills, accent selected state, always-visible custom-answer
 * fields, and one Submit action with draft survival across navigation.
 */
export function MobileQuestionnaireCard(props: MobileQuestionnaireCardProps) {
  const { colors } = useTheme();
  const definitionKey = questionnaireDefinitionKey(props.prompt, props.questionnaire);
  const [draft, setDraft] = useState<QuestionnaireDraft>(() =>
    readMobileQuestionnaireDraft(props.draftKey, definitionKey, props.questionnaire),
  );

  useEffect(() => {
    setDraft(readMobileQuestionnaireDraft(props.draftKey, definitionKey, props.questionnaire));
  }, [props.draftKey, definitionKey, props.questionnaire]);

  const updateDraft = (updater: (current: QuestionnaireDraft) => QuestionnaireDraft) => {
    setDraft((current) => {
      const next = updater(current);
      writeMobileQuestionnaireDraft(props.draftKey, definitionKey, next);
      return next;
    });
  };

  const response = questionnaireResponseOf(props.questionnaire, draft);
  const busy = props.busy === true;
  const watchingOnly = props.watchingOnly === true;
  const questionCount = props.questionnaire.questions.length;
  const showCardPrompt =
    props.prompt.trim().length > 0 &&
    (questionCount > 1 || props.prompt.trim() !== props.questionnaire.questions[0]?.prompt.trim());

  return (
    <View
      accessibilityLabel="Questionnaire"
      style={[
        props.embedded === true ? styles.embeddedCard : styles.card,
        { borderColor: colors.border },
      ]}
      testID={props.testID ?? "mobile-questionnaire-card"}
    >
      <View style={styles.headerRow}>
        <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>Input needed</Text>
        {questionCount > 1 ? (
          <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
            {`${String(questionCount)} questions`}
          </Text>
        ) : null}
      </View>
      {props.subtitle === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {props.subtitle}
        </Text>
      )}
      {showCardPrompt ? (
        <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{props.prompt}</Text>
      ) : null}
      {props.questionnaire.questions.map((question) => {
        const answer = draft.answers.find((entry) => entry.questionId === question.id);
        const selected = answer?.selectedOptionIds ?? [];
        const custom =
          draft.customIds.includes(question.id) || (answer?.customAnswer ?? "").trim().length > 0;
        const max = question.maxSelections ?? question.options.length;
        const role = question.selection === "single" ? "radio" : "checkbox";
        const helpText =
          question.options.length === 0
            ? MOBILE_COPY.workQuestionYourAnswerPlaceholder
            : question.selection === "single"
              ? MOBILE_COPY.workQuestionChooseOne
              : MOBILE_COPY.workQuestionChooseSeveral(question.minSelections ?? 1, max);
        return (
          <View key={question.id} style={styles.question}>
            {question.header === undefined ? null : (
              <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
                {question.header}
              </Text>
            )}
            <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>
              {question.prompt}
            </Text>
            <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
              {helpText}
            </Text>
            {question.options.length === 0 ? null : (
              <View
                accessibilityLabel={question.prompt}
                accessibilityRole={question.selection === "single" ? "radiogroup" : undefined}
                style={styles.choices}
              >
                {question.options.map((option) => {
                  const checked = !custom && selected.includes(option.id);
                  return (
                    <MobileChoice
                      checked={checked}
                      description={option.description}
                      disabled={
                        watchingOnly ||
                        busy ||
                        (role === "checkbox" && !checked && !custom && selected.length >= max)
                      }
                      key={option.id}
                      label={option.label}
                      onPress={() =>
                        updateDraft((current) =>
                          chooseQuestionnaireOption(current, question, option.id),
                        )
                      }
                      recommended={option.recommended}
                      role={role}
                    />
                  );
                })}
              </View>
            )}
            {watchingOnly || question.allowCustom === false ? null : (
              <TextInput
                accessibilityLabel={
                  questionCount > 1
                    ? `${MOBILE_COPY.workQuestionYourAnswer}: ${question.prompt}`
                    : MOBILE_COPY.workQuestionYourAnswer
                }
                editable={!busy}
                maxLength={2_000}
                multiline
                onChangeText={(text) =>
                  updateDraft((current) => writeQuestionnaireCustom(current, question, text))
                }
                placeholder={MOBILE_COPY.workQuestionYourAnswerPlaceholder}
                placeholderTextColor={colors.textSecondary}
                style={[
                  styles.input,
                  {
                    color: colors.textPrimary,
                    borderColor: custom ? colors.accent : colors.hairlineStrong,
                    backgroundColor: custom ? withAlpha(colors.accent, 0.08) : "transparent",
                  },
                ]}
                value={answer?.customAnswer ?? ""}
              />
            )}
          </View>
        );
      })}
      {watchingOnly || props.questionnaire.allowComment === false ? null : (
        <TextInput
          accessibilityLabel={MOBILE_COPY.workQuestionComment}
          editable={!busy}
          maxLength={2_000}
          multiline
          onChangeText={(comment) => updateDraft((current) => ({ ...current, comment }))}
          placeholder={MOBILE_COPY.workQuestionComment}
          placeholderTextColor={colors.textSecondary}
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.hairlineStrong }]}
          value={draft.comment}
        />
      )}
      {watchingOnly ? null : (
        <>
          <MobilePrimaryButton
            disabled={busy || response === undefined}
            label={busy ? MOBILE_COPY.workQuestionSending : MOBILE_COPY.workQuestionSendAnswers}
            onPress={() => {
              if (response === undefined) return;
              void Promise.resolve(props.onSubmit(response)).then((accepted) => {
                if (accepted) {
                  clearMobileQuestionnaireDraft(props.draftKey);
                }
              });
            }}
            testID={props.submitTestID ?? "mobile-questionnaire-submit"}
          />
          {props.onDismiss === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              hitSlop={8}
              onPress={props.onDismiss}
              style={styles.quiet}
              testID={props.dismissTestID ?? "mobile-questionnaire-dismiss"}
            >
              <Text style={[mobileTypography.body, { color: colors.textSecondary }]}>
                {MOBILE_COPY.workQuestionDismiss}
              </Text>
            </Pressable>
          )}
        </>
      )}
      {props.note === undefined ? null : (
        <Text
          accessibilityLiveRegion="polite"
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID={props.noteTestID ?? "mobile-questionnaire-note"}
        >
          {props.note}
        </Text>
      )}
    </View>
  );
}

const CUSTOM = "octant-question-custom";

/**
 * Single plain or secret provider question on mobile (when no structured
 * questionnaire was supplied, or when the question asks for a secret).
 */
export function MobileSingleQuestionCard(props: {
  readonly prompt: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description?: string | undefined;
  }>;
  readonly secret?: boolean | undefined;
  readonly watchingOnly?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly note?: string | undefined;
  readonly onSubmit: (answer: string) => void | Promise<void>;
  readonly testID?: string | undefined;
  readonly submitTestID?: string | undefined;
  readonly noteTestID?: string | undefined;
}) {
  const { colors } = useTheme();
  const secret = props.secret === true;
  const [selected, setSelected] = useState<string | undefined>(secret ? CUSTOM : undefined);
  const [written, setWritten] = useState("");
  const [revealed, setRevealed] = useState(false);
  const custom = selected === CUSTOM;
  const answer = custom
    ? secret
      ? written
      : written.trim()
    : (props.options.find((option) => option.label === selected)?.label ?? "");
  const blank = custom ? written.trim().length === 0 : answer.length === 0;
  const busy = props.busy === true;
  const watchingOnly = props.watchingOnly === true;

  return (
    <View
      accessibilityLabel="Provider question"
      style={[styles.card, { borderColor: colors.border }]}
      testID={props.testID ?? "mobile-provider-question"}
    >
      <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>Input needed</Text>
      <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{props.prompt}</Text>
      {secret ? null : (
        <View accessibilityRole="radiogroup" style={styles.choices}>
          {props.options.map((option) => (
            <MobileChoice
              checked={selected === option.label}
              description={option.description}
              disabled={watchingOnly || busy}
              key={option.label}
              label={option.label}
              onPress={() => setSelected(option.label)}
              role="radio"
            />
          ))}
          {watchingOnly ? null : (
            <MobileChoice
              checked={custom}
              disabled={busy}
              label={MOBILE_COPY.workQuestionOwnAnswer}
              onPress={() => setSelected(CUSTOM)}
              role="radio"
            />
          )}
        </View>
      )}
      {custom && !watchingOnly ? (
        <View style={styles.secretRow}>
          <TextInput
            accessibilityLabel={secret ? "Your secret answer" : MOBILE_COPY.workQuestionYourAnswer}
            autoCapitalize={secret ? "none" : "sentences"}
            autoCorrect={!secret}
            editable={!busy}
            onChangeText={setWritten}
            placeholder={
              secret ? "Type the secret…" : MOBILE_COPY.workQuestionYourAnswerPlaceholder
            }
            placeholderTextColor={colors.textSecondary}
            secureTextEntry={secret && !revealed}
            style={[
              styles.input,
              styles.secretInput,
              { color: colors.textPrimary, borderColor: colors.hairlineStrong },
            ]}
            value={written}
          />
          {secret ? (
            <Pressable
              accessibilityLabel={revealed ? "Hide answer" : "Show answer"}
              accessibilityRole="button"
              onPress={() => setRevealed((current) => !current)}
              style={styles.quiet}
            >
              <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
                {revealed ? "Hide" : "Show"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {secret ? (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          Sent only to the agent. Octant does not save it or add it to the thread.
        </Text>
      ) : null}
      {watchingOnly ? null : (
        <MobilePrimaryButton
          disabled={busy || blank}
          label={MOBILE_COPY.workQuestionSubmit}
          onPress={() => void props.onSubmit(answer)}
          testID={props.submitTestID ?? "mobile-provider-question-submit"}
        />
      )}
      {props.note === undefined ? null : (
        <Text
          accessibilityLiveRegion="polite"
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
          testID={props.noteTestID ?? "mobile-provider-question-note"}
        >
          {props.note}
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
  embeddedCard: {
    padding: mobileSpacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    gap: mobileSpacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: mobileSpacing.sm,
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
  choiceLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: mobileSpacing.xs,
  },
  recommendedPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
  },
  input: {
    minHeight: 44,
    paddingHorizontal: mobileSpacing.sm,
    paddingVertical: mobileSpacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  secretRow: { flexDirection: "row", alignItems: "center", gap: mobileSpacing.xs },
  secretInput: { flex: 1 },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    marginTop: mobileSpacing.xs,
  },
  quiet: { minHeight: 44, alignItems: "center", justifyContent: "center" },
});
