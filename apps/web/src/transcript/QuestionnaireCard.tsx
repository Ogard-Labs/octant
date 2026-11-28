import { useQuestionnaireDraft, type QuestionnaireDraftIdentity } from "./questionnaireDrafts";
import { OctantAlert } from "../ui/base/OctantAlert";
import { useId, useRef, useState } from "react";
import type { Questionnaire, QuestionnaireResponse } from "@octant/contracts";
import { validateQuestionnaireAnswer } from "@octant/domain";
import { OctantBadge } from "../ui/base/OctantBadge";
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
  const { answers, comment } = draft;
  const setAnswers = (
    update: (current: ReadonlyArray<DraftAnswer>) => ReadonlyArray<DraftAnswer>,
  ) => draft.setDraft((current) => ({ ...current, answers: update(current.answers) }));
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
    "valid";
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

  if (sent !== undefined)
    return (
      <QuestionnaireSummary
        prompt={props.prompt}
        questionnaire={props.questionnaire}
        answer={sent}
        validateAnswer={props.validateAnswer}
      />
    );
  const questions = props.questionnaire.questions;
  // A lone question that is its own title is said once: the legend stays for
  // assistive technology, the eye reads the title.
  const titleIsQuestion = questions.length === 1 && questions[0]?.prompt === props.prompt;
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
      <header className="questionnaire__heading">
        <p className="questionnaire__eyebrow">
          {questions.length === 1 ? "Your input" : `Your input · ${questions.length} questions`}
        </p>
        {titleIsQuestion && questions[0]?.header !== undefined ? (
          <span aria-hidden="true" className="questionnaire__header">
            {questions[0].header}
          </span>
        ) : null}
        <p className="provider-question-card__prompt questionnaire__title">{props.prompt}</p>
      </header>
      {/* The questions scroll inside the card, so its Send stays in view. */}
      <div className="questionnaire__body">
        {questions.map((question, index) => {
          const answer = answers.find((entry) => entry.questionId === question.id);
          const written = answer?.customAnswer ?? "";
          // A written answer that says something is the question's answer; the
          // validator refuses one sent beside chosen options.
          const writing = written.trim() !== "";
          const selected = writing ? [] : (answer?.selectedOptionIds ?? []);
          const max = question.maxSelections ?? question.options.length;
          const choose = (selectedOptionIds: ReadonlyArray<string>) =>
            update({ questionId: question.id, selectedOptionIds });
          const optionLabel = (option: (typeof question.options)[number], optionIndex: number) => (
            <>
              <span className="questionnaire__option-line">
                <span className="provider-question-card__option-label">{option.label}</span>
                {/* The space keeps the pill a separate word in the option's name; flex draws none. */}
                {option.recommended === true ? " " : null}
                {option.recommended === true ? (
                  <OctantBadge className="questionnaire__recommended" variant="secondary">
                    Recommended
                  </OctantBadge>
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
          return (
            <fieldset className="questionnaire__question" disabled={busy} key={question.id}>
              <legend className={titleIsQuestion ? "visually-hidden" : undefined}>
                {question.header === undefined ? null : (
                  <span className="questionnaire__header">{question.header}</span>
                )}{" "}
                <span className="questionnaire__prompt">{question.prompt}</span>
              </legend>
              <p className="provider-question-card__progress" id={`${id}-${index}-help`}>
                {question.selection === "single"
                  ? "Choose one"
                  : `Select ${question.minSelections ?? 1}–${max} options`}
              </p>
              {question.selection === "single" ? (
                <OctantRadioGroup
                  aria-describedby={`${id}-${index}-help`}
                  aria-label={question.prompt}
                  className="provider-question-card__choices"
                  disabled={busy}
                  numberShortcuts
                  onValueChange={(next) => choose([next])}
                  value={selected[0] ?? ""}
                >
                  {question.options.map((option, optionIndex) => (
                    <div
                      className="provider-question-card__choice"
                      data-checked={selected.includes(option.id) ? "" : undefined}
                      key={option.id}
                    >
                      <OctantRadioGroupItem
                        className="provider-question-card__option"
                        size={null}
                        value={option.id}
                        variant="ghost"
                      >
                        {optionLabel(option, optionIndex)}
                      </OctantRadioGroupItem>
                    </div>
                  ))}
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
                    const checked = selected.includes(option.id);
                    return (
                      <div
                        className="provider-question-card__choice"
                        data-checked={checked ? "" : undefined}
                        key={option.id}
                      >
                        <label className="questionnaire__checkbox">
                          <OctantCheckbox
                            checked={checked}
                            onChange={() =>
                              choose(
                                checked
                                  ? selected.filter((value) => value !== option.id)
                                  : [...selected, option.id],
                              )
                            }
                            disabled={!checked && selected.length >= max}
                          />
                          <span>{optionLabel(option, optionIndex)}</span>
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
              {question.allowCustom === false ? null : (
                <label className="questionnaire__written">
                  <span className="provider-question-card__option-description">
                    Your own answer
                  </span>
                  <OctantTextarea
                    maxLength={2_000}
                    placeholder="Write an answer no option covers"
                    rows={1}
                    value={written}
                    onChange={(event) => {
                      const text = event.target.value;
                      update({
                        questionId: question.id,
                        selectedOptionIds:
                          text.trim() === "" ? (answer?.selectedOptionIds ?? []) : [],
                        ...(text === "" ? {} : { customAnswer: text }),
                      });
                    }}
                  />
                </label>
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
      <footer className="provider-question-card__actions questionnaire__actions">
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
