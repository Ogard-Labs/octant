import { OctantAlert } from "../ui/base/OctantAlert";
import { useId, useRef, useState } from "react";
import type { Questionnaire, QuestionnaireResponse } from "@octant/contracts";
import { validateQuestionnaireAnswer } from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { moveWithinRadioGroup } from "../ui/base/radioGroupKeys";

export interface QuestionnaireCardProps {
  readonly prompt: string;
  readonly questionnaire: Questionnaire;
  readonly onAnswer: (answer: string) => void | boolean | Promise<void | boolean>;
  readonly onDismiss?: (() => void) | undefined;
  readonly className?: string | undefined;
}

type DraftAnswer = QuestionnaireResponse["answers"][number];

export function QuestionnaireCard(props: QuestionnaireCardProps) {
  const id = useId();
  const [answers, setAnswers] = useState<ReadonlyArray<DraftAnswer>>(() =>
    props.questionnaire.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: [],
    })),
  );
  const [customIds, setCustomIds] = useState<ReadonlyArray<string>>([]);
  const [comment, setComment] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const submitting = useRef(false);
  const response = {
    version: 1 as const,
    answers: answers.map(({ customAnswer, ...answer }) => ({
      ...answer,
      ...(customAnswer === undefined || customAnswer.trim() === ""
        ? {}
        : { customAnswer: customAnswer.trim() }),
    })),
    ...(comment.trim() === "" ? {} : { comment: comment.trim() }),
  };
  const encoded = JSON.stringify(response);
  const valid =
    validateQuestionnaireAnswer(props.questionnaire, encoded).status === "valid" &&
    customIds.every(
      (questionId) =>
        answers.find((answer) => answer.questionId === questionId)?.customAnswer !== undefined,
    );
  const update = (answer: DraftAnswer) =>
    setAnswers((current) =>
      current.map((entry) => (entry.questionId === answer.questionId ? answer : entry)),
    );

  const send = async () => {
    if (!valid || submitting.current || sent) return;
    submitting.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await props.onAnswer(encoded);
      if (result === false)
        setNotice("The answers were not accepted. Review the thread status and try again.");
      else setSent(true);
    } catch {
      setNotice(
        "The answers could not be confirmed. Your draft is kept. Check the connection before trying again.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  if (sent)
    return (
      <QuestionnaireSummary
        prompt={props.prompt}
        questionnaire={props.questionnaire}
        answer={encoded}
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
      <p className="provider-question-card__prompt">{props.prompt}</p>
      {props.questionnaire.questions.map((question, index) => {
        const answer = answers.find((entry) => entry.questionId === question.id);
        const selected = answer?.selectedOptionIds ?? [];
        const custom = customIds.includes(question.id);
        const max = question.maxSelections ?? question.options.length;
        return (
          <fieldset className="questionnaire__question" disabled={busy} key={question.id}>
            <legend>{question.prompt}</legend>
            <p className="provider-question-card__progress" id={`${id}-${index}-help`}>
              {question.selection === "single"
                ? "Choose one"
                : `Select ${question.minSelections ?? 1}–${max} options`}
            </p>
            <div
              className="provider-question-card__choices"
              role={question.selection === "single" ? "radiogroup" : "group"}
              aria-label={question.prompt}
              aria-describedby={`${id}-${index}-help`}
              onKeyDown={question.selection === "single" ? moveWithinRadioGroup : undefined}
            >
              {question.options.map((option) => {
                const checked = !custom && selected.includes(option.id);
                const label = (
                  <>
                    <span className="provider-question-card__option-label">
                      {option.label}
                      {option.recommended === true ? " (Recommended)" : ""}
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
                    selectedOptionIds:
                      question.selection === "single"
                        ? [option.id]
                        : checked
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
                    {question.selection === "single" ? (
                      <OctantButton
                        aria-checked={checked}
                        className="provider-question-card__option"
                        size={null}
                        role="radio"
                        type="button"
                        variant="ghost"
                        onClick={choose}
                      >
                        {label}
                      </OctantButton>
                    ) : (
                      <label className="questionnaire__checkbox">
                        <OctantCheckbox
                          checked={checked}
                          onChange={choose}
                          disabled={!checked && !custom && selected.length >= max}
                        />
                        <span>{label}</span>
                      </label>
                    )}
                  </div>
                );
              })}
              {question.allowCustom === false ? null : (
                <div
                  className="provider-question-card__choice"
                  data-checked={custom ? "" : undefined}
                >
                  <OctantButton
                    aria-checked={custom}
                    className="provider-question-card__option"
                    size={null}
                    role={question.selection === "single" ? "radio" : "checkbox"}
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setCustomIds((current) =>
                        custom
                          ? current.filter((value) => value !== question.id)
                          : [...current, question.id],
                      );
                      update({ questionId: question.id, selectedOptionIds: [] });
                    }}
                  >
                    Write another answer
                  </OctantButton>
                  {custom ? (
                    <label className="questionnaire__written">
                      Your answer
                      <OctantTextarea
                        maxLength={2_000}
                        rows={2}
                        value={answer?.customAnswer ?? ""}
                        onChange={(event) =>
                          update({
                            questionId: question.id,
                            selectedOptionIds: [],
                            ...(event.target.value.trim() === ""
                              ? {}
                              : { customAnswer: event.target.value }),
                          })
                        }
                      />
                    </label>
                  ) : null}
                </div>
              )}
            </div>
          </fieldset>
        );
      })}
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
          {busy ? "Sending answers…" : "Send answers"}
        </OctantButton>
      </footer>
    </form>
  );
}

export function QuestionnaireSummary(props: {
  readonly prompt: string;
  readonly questionnaire: Questionnaire;
  readonly answer: string;
}) {
  const validated = validateQuestionnaireAnswer(props.questionnaire, props.answer);
  if (validated.status === "invalid")
    return <p role="status">Submitted answers are unavailable.</p>;
  return (
    <details className="questionnaire-summary">
      <summary>Answers sent · {props.prompt}</summary>
      <dl>
        {props.questionnaire.questions.map((question) => {
          const answer = validated.response.answers.find(
            (entry) => entry.questionId === question.id,
          );
          const text =
            answer?.customAnswer ??
            question.options
              .filter((option) => answer?.selectedOptionIds.includes(option.id))
              .map((option) => option.label)
              .join(", ");
          return (
            <div key={question.id}>
              <dt>{question.prompt}</dt>
              <dd>{text || "None selected"}</dd>
            </div>
          );
        })}
        {validated.response.comment === undefined ? null : (
          <div>
            <dt>Comment</dt>
            <dd>{validated.response.comment}</dd>
          </div>
        )}
      </dl>
    </details>
  );
}
