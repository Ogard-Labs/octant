import { useQuestionnaireDraft, type QuestionnaireDraftIdentity } from "./questionnaireDrafts";
import { OctantAlert } from "../ui/base/OctantAlert";
import { useId, useRef, useState } from "react";
import type { Questionnaire, QuestionnaireResponse } from "@octant/contracts";
import { validateQuestionnaireAnswer } from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantRadioGroup, OctantRadioGroupItem } from "../ui/base/OctantRadioGroup";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { chooseByNumber } from "../ui/base/radioGroupKeys";
import { OptionKey } from "./OptionKey";
import { QuestionnaireSummary, type QuestionnaireAnswerRule } from "./QuestionnaireSummary";

export { QuestionnaireSummary, type QuestionnaireAnswerRule };

export interface QuestionnaireCardProps {
  readonly draftIdentity?: QuestionnaireDraftIdentity | undefined;
  readonly prompt: string;
  readonly questionnaire: Questionnaire;
  /**
   * `false` keeps the draft with a generic notice; `{ refused }` keeps it with
   * the host's own reason, so a person reads why their answer did not go.
   */
  readonly onAnswer: (
    answer: string,
  ) => void | boolean | QuestionnaireRefusal | Promise<void | boolean | QuestionnaireRefusal>;
  readonly onDismiss?: (() => void) | undefined;
  /** The send button's words; a Canvas names the thread the answer goes to. */
  readonly submitLabel?: string | undefined;
  readonly className?: string | undefined;
  /** The rule an answer is checked against; a Canvas form passes its own, without the inline ask's ceilings. */
  readonly validateAnswer?: QuestionnaireAnswerRule | undefined;
}

export interface QuestionnaireRefusal {
  readonly refused: string;
}

type DraftAnswer = QuestionnaireResponse["answers"][number];

export function QuestionnaireCard(props: QuestionnaireCardProps) {
  return (
    <QuestionnaireEditor
      key={JSON.stringify([props.draftIdentity, props.prompt, props.questionnaire])}
      {...props}
    />
  );
}

function QuestionnaireEditor(props: QuestionnaireCardProps) {
  const id = useId();
  const draft = useQuestionnaireDraft(props.draftIdentity, props.prompt, props.questionnaire);
  const { answers, customIds, comment } = draft;
  const setAnswers = (
    update: (current: ReadonlyArray<DraftAnswer>) => ReadonlyArray<DraftAnswer>,
  ) => draft.setDraft((current) => ({ ...current, answers: update(current.answers) }));
  const setCustomIds = (update: (current: ReadonlyArray<string>) => ReadonlyArray<string>) =>
    draft.setDraft((current) => ({ ...current, customIds: update(current.customIds) }));
  const setComment = (comment: string) => draft.setDraft((current) => ({ ...current, comment }));
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string>();
  const submitting = useRef(false);
  const response = {
    version: 1 as const,
    answers: answers.map(({ customAnswer, ...answer }) => ({
      ...answer,
      ...(customAnswer === undefined || customAnswer.trim() === ""
        ? {}
        : { customAnswer: customAnswer.trim() }),
    })),
    ...(props.questionnaire.allowComment === false || comment.trim() === ""
      ? {}
      : { comment: comment.trim() }),
  };
  const encoded = JSON.stringify(response);
  const valid =
    (props.validateAnswer ?? validateQuestionnaireAnswer)(props.questionnaire, encoded).status ===
      "valid" &&
    customIds.every(
      (questionId) =>
        answers.find((answer) => answer.questionId === questionId)?.customAnswer !== undefined,
    );
  const update = (answer: DraftAnswer) =>
    setAnswers((current) =>
      current.map((entry) => (entry.questionId === answer.questionId ? answer : entry)),
    );

  const send = async () => {
    if (!valid || submitting.current || sent !== undefined) return;
    submitting.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await props.onAnswer(encoded);
      if (result === false)
        setNotice("The answers were not accepted. Review the thread status and try again.");
      else if (typeof result === "object") setNotice(result.refused);
      else {
        draft.clear();
        setSent(encoded);
      }
    } catch {
      setNotice(
        "The answers could not be confirmed. Your draft is kept. Check the connection before trying again.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const questionCount = props.questionnaire.questions.length;
  const showCardPrompt =
    props.prompt.trim().length > 0 &&
    (questionCount > 1 || props.prompt.trim() !== props.questionnaire.questions[0]?.prompt.trim());

  const writeCustomAnswer = (questionId: string, rawValue: string) => {
    const hasCharacters = rawValue.length > 0;
    setCustomIds((current) =>
      hasCharacters
        ? current.includes(questionId)
          ? current
          : [...current, questionId]
        : current.filter((value) => value !== questionId),
    );
    update({
      questionId,
      selectedOptionIds: [],
      ...(hasCharacters ? { customAnswer: rawValue } : {}),
    });
  };

  if (sent !== undefined)
    return (
      <QuestionnaireSummary
        prompt={props.prompt}
        questionnaire={props.questionnaire}
        answer={sent}
        validateAnswer={props.validateAnswer}
      />
    );
  return (
    <form
      aria-label="Questionnaire"
      className={`provider-question-card questionnaire${props.className === undefined ? "" : ` ${props.className}`}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <header className="questionnaire__header">
        <h3 className="questionnaire__heading">Input needed</h3>
        {questionCount > 1 ? (
          <span className="questionnaire__count">{`${String(questionCount)} questions`}</span>
        ) : null}
      </header>
      {showCardPrompt ? <p className="provider-question-card__prompt">{props.prompt}</p> : null}
      <div className="questionnaire__body">
        {props.questionnaire.questions.map((question, index) => {
          const answer = answers.find((entry) => entry.questionId === question.id);
          const selected = answer?.selectedOptionIds ?? [];
          const custom =
            customIds.includes(question.id) || (answer?.customAnswer ?? "").trim().length > 0;
          const max = question.maxSelections ?? question.options.length;
          const helpText =
            question.options.length === 0
              ? "Write your answer"
              : question.selection === "single"
                ? "Choose one"
                : `Select ${question.minSelections ?? 1}–${max} options`;
          return (
            <fieldset className="questionnaire__question" disabled={busy} key={question.id}>
              {question.header === undefined ? null : (
                <span className="questionnaire__question-header">{question.header}</span>
              )}
              <legend>{question.prompt}</legend>
              <p className="provider-question-card__progress" id={`${id}-${index}-help`}>
                {helpText}
              </p>
              {question.options.length === 0 ? null : question.selection === "single" ? (
                <OctantRadioGroup
                  aria-describedby={`${id}-${index}-help`}
                  aria-label={question.prompt}
                  className="provider-question-card__choices"
                  disabled={busy}
                  numberShortcuts
                  onValueChange={(next) => {
                    setCustomIds((current) => current.filter((value) => value !== question.id));
                    update({ questionId: question.id, selectedOptionIds: [next] });
                  }}
                  value={custom ? "" : (selected[0] ?? "")}
                >
                  {question.options.map((option, optionIndex) => {
                    const checked = !custom && selected.includes(option.id);
                    return (
                      <div
                        className="provider-question-card__choice"
                        data-checked={checked ? "" : undefined}
                        key={option.id}
                      >
                        <OctantRadioGroupItem
                          className="provider-question-card__option"
                          size={null}
                          value={option.id}
                          variant="ghost"
                        >
                          <span className="provider-question-card__option-label">
                            <span>{option.label}</span>
                            {option.recommended === true ? (
                              <>
                                {" "}
                                <span className="questionnaire__recommended-pill">Recommended</span>
                              </>
                            ) : null}
                            <OptionKey index={optionIndex} />
                          </span>
                          {option.description === undefined ? null : (
                            <span className="provider-question-card__option-description">
                              {option.description}
                            </span>
                          )}
                        </OctantRadioGroupItem>
                      </div>
                    );
                  })}
                </OctantRadioGroup>
              ) : (
                <div
                  className="provider-question-card__choices"
                  role="group"
                  aria-label={question.prompt}
                  aria-describedby={`${id}-${index}-help`}
                  onKeyDown={chooseByNumber}
                >
                  {question.options.map((option, optionIndex) => {
                    const checked = !custom && selected.includes(option.id);
                    const label = (
                      <>
                        <span className="provider-question-card__option-label">
                          <span>{option.label}</span>
                          {option.recommended === true ? (
                            <>
                              {" "}
                              <span className="questionnaire__recommended-pill">Recommended</span>
                            </>
                          ) : null}
                          <OptionKey index={optionIndex} />
                        </span>
                        {option.description === undefined ? null : (
                          <span className="provider-question-card__option-description">
                            {option.description}
                          </span>
                        )}
                      </>
                    );
                    const choose = () => {
                      setCustomIds((current) => current.filter((value) => value !== question.id));
                      update({
                        questionId: question.id,
                        selectedOptionIds: checked
                          ? selected.filter((value) => value !== option.id)
                          : [...(custom ? [] : selected), option.id],
                      });
                    };
                    return (
                      <div
                        className="provider-question-card__choice"
                        data-checked={checked ? "" : undefined}
                        key={option.id}
                      >
                        <label className="questionnaire__checkbox">
                          <OctantCheckbox
                            checked={checked}
                            onChange={choose}
                            disabled={!checked && !custom && selected.length >= max}
                          />
                          <span>{label}</span>
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
              {question.allowCustom === false ? null : (
                <div className="questionnaire__custom-field" data-checked={custom ? "" : undefined}>
                  <label className="questionnaire__written">
                    <span className="questionnaire__written-label">Your answer</span>
                    <OctantTextarea
                      disabled={busy}
                      maxLength={2_000}
                      placeholder="Type your own answer…"
                      rows={1}
                      value={answer?.customAnswer ?? ""}
                      onChange={(event) => writeCustomAnswer(question.id, event.target.value)}
                    />
                  </label>
                </div>
              )}
            </fieldset>
          );
        })}
        {props.questionnaire.allowComment === false ? null : (
          <label className="questionnaire__written">
            Anything to add?{" "}
            <span className="provider-question-card__option-description">Optional</span>
            <OctantTextarea
              disabled={busy}
              maxLength={2_000}
              rows={2}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
        )}
      </div>
      {notice === undefined ? null : <OctantAlert tone="warning">{notice}</OctantAlert>}
      <footer className="provider-question-card__actions">
        {props.onDismiss === undefined ? (
          <span />
        ) : (
          <OctantButton
            disabled={busy}
            onClick={props.onDismiss}
            size="sm"
            type="button"
            variant="ghost"
          >
            Dismiss
          </OctantButton>
        )}
        <OctantButton disabled={!valid || busy} size="sm" type="submit">
          {busy ? "Sending answers…" : (props.submitLabel ?? "Send answers")}
        </OctantButton>
      </footer>
    </form>
  );
}
