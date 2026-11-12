import type {
  CanvasChoiceAnswer,
  CanvasChoiceAnswerChange,
  CanvasChoiceBlock,
} from "@octant/contracts";
import {
  canvasChoiceFormState,
  canvasChoiceQuestionFingerprint,
  canvasChoiceRecommendedSelection,
  questionAnswerIsAllowed,
} from "@octant/domain";
import { useEffect, useId, useRef, useState } from "react";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantBadge } from "../../ui/base/OctantBadge";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantCheckbox } from "../../ui/base/OctantCheckbox";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { moveWithinRadioGroup } from "../../ui/base/radioGroupKeys";
import type { CanvasChoiceSaveResult } from "./useCanvasChoiceAnswers";

type Question = CanvasChoiceBlock["questions"][number];

interface Draft {
  readonly selected: ReadonlyArray<string>;
  readonly custom: boolean;
  readonly text: string;
  readonly note: string;
}

type QuestionStatus =
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "refused"; readonly message: string };

const SAVE_DELAY_MS = 600;

const draftFromAnswer = (answer: CanvasChoiceAnswer | undefined): Draft => ({
  selected: answer?.selectedOptionIds ?? [],
  custom: answer?.customAnswer !== undefined,
  text: answer?.customAnswer ?? "",
  note: answer?.note ?? "",
});

export interface DecisionFormProps {
  readonly block: CanvasChoiceBlock;
  readonly answers: ReadonlyArray<CanvasChoiceAnswer>;
  readonly save: (
    changes: ReadonlyArray<CanvasChoiceAnswerChange>,
  ) => Promise<CanvasChoiceSaveResult>;
  /** Present when the person may answer here; absent, the form shows saved answers and says why. */
  readonly editable: boolean;
  readonly note?: string | undefined;
  readonly send?:
    | {
        readonly label: string;
        readonly onSend: (
          answers: ReadonlyArray<CanvasChoiceAnswer>,
        ) => Promise<
          { readonly status: "sent" } | { readonly status: "refused"; readonly message: string }
        >;
      }
    | undefined;
}

/**
 * A choice block drawn as a decision form: sections of questions whose answers
 * save as they are made, a progress count, an action that accepts the agent's
 * recommendations, and an explicit Send that tells the thread. Saving grants
 * nothing and wakes no one; Send is the person's own message.
 */
export function DecisionForm(props: DecisionFormProps) {
  const { block, answers } = props;
  const id = useId();
  const form = canvasChoiceFormState(block, answers);
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [statuses, setStatuses] = useState<Readonly<Record<string, QuestionStatus>>>({});
  const [sendState, setSendState] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "sending" }
    | { readonly kind: "sent" }
    | { readonly kind: "refused"; readonly message: string }
  >({ kind: "idle" });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Questions with a write the host has not settled. An emptied selection must
  // still queue a clear behind such a write, or the write lands afterwards and
  // brings back the option the person just took away.
  const inFlight = useRef(new Map<string, number>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const setStatus = (questionId: string, status: QuestionStatus | undefined) =>
    setStatuses((current) => {
      const { [questionId]: _removed, ...rest } = current;
      return status === undefined ? rest : { ...rest, [questionId]: status };
    });

  const savedFor = (question: Question) =>
    form.questions.find((entry) => entry.question.id === question.id)?.answer;
  const draftFor = (question: Question): Draft =>
    drafts[question.id] ?? draftFromAnswer(savedFor(question));

  /** Save one question's draft when it is a whole answer; otherwise keep it local. */
  const commit = async (question: Question, draft: Draft, accepted = false) => {
    const saved = savedFor(question);
    const text = draft.text.trim();
    const note = question.allowNote === false ? "" : draft.note.trim();
    let change: CanvasChoiceAnswerChange | undefined;
    if (draft.custom) {
      if (text !== "") {
        change = {
          kind: "set",
          blockId: block.blockId,
          questionId: question.id,
          questionFingerprint: canvasChoiceQuestionFingerprint(question),
          selectedOptionIds: [],
          customAnswer: text,
          ...(note === "" ? {} : { note }),
        };
      }
    } else if (draft.selected.length === 0) {
      if (saved !== undefined || (inFlight.current.get(question.id) ?? 0) > 0) {
        change = { kind: "clear", blockId: block.blockId, questionId: question.id };
      }
    } else if (questionAnswerIsAllowed(question, { selectedOptionIds: draft.selected })) {
      change = {
        kind: "set",
        blockId: block.blockId,
        questionId: question.id,
        questionFingerprint: canvasChoiceQuestionFingerprint(question),
        selectedOptionIds: draft.selected,
        ...(note === "" ? {} : { note }),
        ...(accepted ? { acceptedRecommendation: true as const } : {}),
      };
    }
    // A draft is dropped only while it is still the one that was saved: the
    // person may have kept typing while the host took this save, and a later
    // keystroke must not be put back to the older text.
    const dropIfUnchanged = () =>
      setDrafts((current) => {
        if (current[question.id] !== draft) return current;
        const { [question.id]: _settled, ...rest } = current;
        return rest;
      });
    if (change === undefined) {
      // Nothing to save, and nothing displayed that the host lacks: a blank
      // choice with no saved answer is not an unsaved edit.
      if (!draft.custom && draft.selected.length === 0 && saved === undefined) dropIfUnchanged();
      return;
    }
    setStatus(question.id, { kind: "saving" });
    inFlight.current.set(question.id, (inFlight.current.get(question.id) ?? 0) + 1);
    const result = await props.save([change]);
    inFlight.current.set(question.id, (inFlight.current.get(question.id) ?? 1) - 1);
    if (result.status === "saved") {
      setStatus(question.id, { kind: "saved" });
      dropIfUnchanged();
    } else {
      setStatus(question.id, { kind: "refused", message: result.message });
    }
  };

  const edit = (question: Question, draft: Draft, delay: boolean) => {
    setDrafts((current) => ({ ...current, [question.id]: draft }));
    const timer = timers.current.get(question.id);
    if (timer !== undefined) clearTimeout(timer);
    if (!delay) {
      void commit(question, draft);
      return;
    }
    timers.current.set(
      question.id,
      setTimeout(() => void commit(question, draft), SAVE_DELAY_MS),
    );
  };

  const eligible = form.questions.filter(
    (entry) =>
      entry.answer === undefined &&
      drafts[entry.question.id] === undefined &&
      canvasChoiceRecommendedSelection(entry.question) !== undefined,
  );
  const acceptRecommendations = async () => {
    const changes = eligible.flatMap((entry): ReadonlyArray<CanvasChoiceAnswerChange> => {
      const selected = canvasChoiceRecommendedSelection(entry.question);
      return selected === undefined
        ? []
        : [
            {
              kind: "set",
              blockId: block.blockId,
              questionId: entry.question.id,
              questionFingerprint: canvasChoiceQuestionFingerprint(entry.question),
              selectedOptionIds: selected,
              acceptedRecommendation: true,
            },
          ];
    });
    if (changes.length === 0) return;
    for (const entry of eligible) setStatus(entry.question.id, { kind: "saving" });
    const result = await props.save(changes);
    for (const entry of eligible) {
      setStatus(
        entry.question.id,
        result.status === "saved"
          ? { kind: "saved" }
          : { kind: "refused", message: result.message },
      );
    }
  };

  // What is on screen differs from what the host holds while a draft is
  // waiting to save, a save is in flight, or a save was refused (its draft is
  // kept). Sending then would put an older decision in front of the agent.
  // Only questions the block still has count: an agent may have removed one
  // while it held a draft, and no control remains to settle that draft.
  const presentIds = new Set(block.questions.map((question) => question.id));
  const unsaved =
    Object.keys(drafts).some((questionId) => presentIds.has(questionId)) ||
    Object.entries(statuses).some(
      ([questionId, status]) => presentIds.has(questionId) && status.kind === "saving",
    );
  const send = async () => {
    if (props.send === undefined || sendState.kind === "sending" || unsaved) return;
    setSendState({ kind: "sending" });
    const result = await props.send.onSend(
      form.questions.flatMap((entry) => (entry.answer === undefined ? [] : [entry.answer])),
    );
    setSendState(
      result.status === "sent" ? { kind: "sent" } : { kind: "refused", message: result.message },
    );
  };

  const sections = block.sections ?? [
    {
      id: "all",
      title: undefined,
      intro: undefined,
      questionIds: block.questions.map((q) => q.id),
    },
  ];
  const stale = form.questions.filter((entry) => entry.stale !== undefined).length;
  const withoutRecommendation = form.questions.filter(
    (entry) =>
      entry.answer === undefined && canvasChoiceRecommendedSelection(entry.question) === undefined,
  ).length;

  return (
    <div
      className="canvas-choice decision-form"
      data-state={props.editable ? "can-send" : "read-only"}
    >
      <header className="decision-form__header">
        <p className="provider-question-card__prompt">{block.prompt}</p>
        <p className="decision-form__progress" role="status" aria-live="polite">
          {form.answered} of {form.total} answered
          {stale > 0 ? ` · ${String(stale)} changed since you answered` : ""}
        </p>
        {props.editable ? (
          <div className="decision-form__actions">
            {eligible.length > 0 ? (
              <OctantButton
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void acceptRecommendations()}
              >
                Accept every recommendation not yet answered
              </OctantButton>
            ) : null}
            {props.send === undefined ? null : (
              <OctantButton
                type="button"
                size="sm"
                disabled={!form.canSend || unsaved || sendState.kind === "sending"}
                onClick={() => void send()}
              >
                {props.send.label}
              </OctantButton>
            )}
          </div>
        ) : null}
        {eligible.length > 0 && withoutRecommendation > 0 ? (
          <p className="canvas-choice__note">
            {withoutRecommendation} of the remaining questions have no recommendation.
          </p>
        ) : null}
        {sendState.kind === "sent" ? (
          <p className="canvas-choice__note" role="status">
            Answers sent. You can keep editing and send again.
          </p>
        ) : null}
        {sendState.kind === "refused" ? (
          <OctantAlert tone="warning">{sendState.message}</OctantAlert>
        ) : null}
        {props.editable && unsaved ? (
          <p className="canvas-choice__note" role="status">
            {Object.values(statuses).some((status) => status.kind === "refused")
              ? "Fix the answers that were not saved before you send."
              : "Waiting for your latest answers to save before you can send."}
          </p>
        ) : null}
        {props.editable && !form.canSend && sendState.kind === "idle" ? (
          <p className="canvas-choice__note">Answer every question that is not optional to send.</p>
        ) : null}
        {props.note === undefined ? null : (
          <p className="canvas-choice__note" role="note">
            {props.note}
          </p>
        )}
      </header>
      {sections.map((section) => (
        <section
          className="decision-form__section"
          key={section.id}
          aria-labelledby={section.title === undefined ? undefined : `${id}-${section.id}`}
        >
          {section.title === undefined ? null : (
            <h3 className="decision-form__section-title" id={`${id}-${section.id}`}>
              {section.title}
            </h3>
          )}
          {section.intro === undefined ? null : (
            <p className="decision-form__section-intro">{section.intro}</p>
          )}
          {section.questionIds.flatMap((questionId) => {
            const question = block.questions.find((candidate) => candidate.id === questionId);
            return question === undefined
              ? []
              : [
                  <DecisionQuestion
                    key={question.id}
                    question={question}
                    draft={draftFor(question)}
                    answer={savedFor(question)}
                    stale={form.questions.some(
                      (entry) => entry.question.id === question.id && entry.stale !== undefined,
                    )}
                    status={statuses[question.id]}
                    editable={props.editable}
                    onEdit={(draft, delay) => edit(question, draft, delay)}
                  />,
                ];
          })}
        </section>
      ))}
    </div>
  );
}

function DecisionQuestion(props: {
  readonly question: Question;
  readonly draft: Draft;
  readonly answer: CanvasChoiceAnswer | undefined;
  readonly stale: boolean;
  readonly status: QuestionStatus | undefined;
  readonly editable: boolean;
  readonly onEdit: (draft: Draft, delayed: boolean) => void;
}) {
  const { question, draft, editable } = props;
  const id = useId();
  const max = question.maxSelections ?? question.options.length;
  const accepted = props.answer?.acceptedRecommendation === true;
  return (
    <fieldset className="questionnaire__question decision-form__question" disabled={!editable}>
      <legend>
        {question.prompt}
        {question.minSelections === 0 ? (
          <span className="decision-form__optional"> (optional)</span>
        ) : null}
      </legend>
      <p className="provider-question-card__progress" id={`${id}-help`}>
        {question.selection === "single"
          ? "Choose one"
          : `Select ${String(question.minSelections ?? 1)}–${String(max)} options`}
      </p>
      <div
        className="provider-question-card__choices"
        role={question.selection === "single" ? "radiogroup" : "group"}
        aria-label={question.prompt}
        aria-describedby={`${id}-help`}
        onKeyDown={question.selection === "single" ? moveWithinRadioGroup : undefined}
      >
        {question.options.map((option) => {
          const checked = !draft.custom && draft.selected.includes(option.id);
          const label = (
            <>
              <span className="provider-question-card__option-label">
                {option.label}
                {option.recommended === true ? (
                  <>
                    {" "}
                    <OctantBadge variant="outline">Recommended</OctantBadge>
                  </>
                ) : null}
              </span>
              {option.description === undefined ? null : (
                <span className="provider-question-card__option-description">
                  {option.description}
                </span>
              )}
            </>
          );
          const choose = () =>
            props.onEdit(
              {
                ...draft,
                custom: false,
                text: "",
                selected:
                  question.selection === "single"
                    ? [option.id]
                    : checked
                      ? draft.selected.filter((value) => value !== option.id)
                      : [...(draft.custom ? [] : draft.selected), option.id],
              },
              false,
            );
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
                    disabled={!checked && !draft.custom && draft.selected.length >= max}
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
            data-checked={draft.custom ? "" : undefined}
          >
            <OctantButton
              aria-checked={draft.custom}
              className="provider-question-card__option"
              size={null}
              role={question.selection === "single" ? "radio" : "checkbox"}
              type="button"
              variant="ghost"
              onClick={() =>
                props.onEdit(
                  draft.custom
                    ? { ...draft, custom: false, text: "" }
                    : { ...draft, custom: true, selected: [] },
                  draft.custom ? false : true,
                )
              }
            >
              Write another answer
            </OctantButton>
            {draft.custom ? (
              <label className="questionnaire__written">
                Your answer
                <OctantTextarea
                  maxLength={2_000}
                  rows={2}
                  value={draft.text}
                  onChange={(event) => props.onEdit({ ...draft, text: event.target.value }, true)}
                />
              </label>
            ) : null}
          </div>
        )}
      </div>
      {question.allowNote === false ? null : (
        <label className="questionnaire__written">
          Note <span className="provider-question-card__option-description">Optional</span>
          <OctantTextarea
            maxLength={2_000}
            rows={2}
            value={draft.note}
            onChange={(event) => props.onEdit({ ...draft, note: event.target.value }, true)}
          />
        </label>
      )}
      <p className="decision-form__status" role="status">
        {props.status?.kind === "saving"
          ? "Saving…"
          : props.status?.kind === "refused"
            ? `Not saved: ${props.status.message}`
            : props.stale
              ? "This question changed since you answered it. Answer it again."
              : accepted
                ? "Accepted the recommendation"
                : props.answer !== undefined
                  ? "Saved"
                  : ""}
      </p>
    </fieldset>
  );
}
