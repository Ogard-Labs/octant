import {
  CanvasChoiceAnswersReviseCommand,
  type CanvasChoiceAnswer,
  type CanvasChoiceAnswerDenialCode,
  type CanvasChoiceAnswerEvent,
} from "@octant/contracts/canvas-choice-answer";
import type { CanvasBlock, CanvasChoiceBlock } from "@octant/contracts/canvas";
import type { CanvasActor } from "@octant/contracts";
import { Schema } from "effect";
import { questionAnswerIsAllowed } from "./questionnaire";

type ChoiceQuestion = CanvasChoiceBlock["questions"][number];
type Timestamp = CanvasChoiceAnswer["answeredAt"];

/**
 * A short digest of what a question asks and offers: its id, prompt, kind of
 * selection, option ids and labels, selection limits, and whether it takes a
 * written answer or a note. An answer is kept only while the question it was
 * made against reads the same, so an agent's reworded or re-optioned question
 * is asked again rather than inheriting an answer to a different one. (A
 * 53-bit string hash: it detects a change, it does not defend against one.)
 */
export function canvasChoiceQuestionFingerprint(question: ChoiceQuestion): string {
  const text = JSON.stringify([
    question.id,
    question.prompt,
    question.selection,
    question.options.map((option) => [option.id, option.label]),
    question.minSelections ?? null,
    question.maxSelections ?? null,
    question.allowCustom ?? null,
    question.allowNote ?? null,
  ]);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface CanvasChoiceAnswerState {
  readonly sequence: number;
  readonly answers: ReadonlyArray<CanvasChoiceAnswer>;
}

export const EMPTY_CANVAS_CHOICE_ANSWER_STATE: CanvasChoiceAnswerState = {
  sequence: 0,
  answers: [],
};

const sameQuestion = (
  entry: { readonly blockId: string; readonly questionId: string },
  blockId: string,
  questionId: string,
) => String(entry.blockId) === blockId && entry.questionId === questionId;

/** Fold one journaled event into the answers; replay and a live write use this one rule. */
export function applyCanvasChoiceAnswerEvent(
  state: CanvasChoiceAnswerState,
  event: CanvasChoiceAnswerEvent,
): CanvasChoiceAnswerState {
  if (event.kind === "set") {
    const { answer } = event.event;
    return {
      sequence: event.event.sequence,
      answers: [
        ...state.answers.filter(
          (entry) => !sameQuestion(entry, String(answer.blockId), answer.questionId),
        ),
        answer,
      ],
    };
  }
  const { blockId, questionId } = event.event;
  return {
    sequence: event.event.sequence,
    answers: state.answers.filter((entry) => !sameQuestion(entry, String(blockId), questionId)),
  };
}

export type CanvasChoiceAnswerAdmission =
  | { readonly kind: "accepted"; readonly events: ReadonlyArray<CanvasChoiceAnswerEvent> }
  | {
      readonly kind: "rejected";
      readonly code: CanvasChoiceAnswerDenialCode;
      readonly message: string;
    };

const reject = (code: CanvasChoiceAnswerDenialCode, message: string) =>
  ({ kind: "rejected", code, message }) as const;

/**
 * Decide a person's changes to a decision form's answers against the Canvas's
 * head version. Nothing is admitted unless every change is: the changes name a
 * choice block and question that exist there, carry the fingerprint the window
 * drew, obey the question's own rule, and arrive against the sequence the
 * window saw. The author and time are the host's, never the request's.
 */
export function admitCanvasChoiceAnswersRevision(
  input: unknown,
  head: { readonly blocks: ReadonlyArray<CanvasBlock> },
  state: CanvasChoiceAnswerState,
  person: CanvasActor,
  at: Timestamp,
): CanvasChoiceAnswerAdmission {
  let command: CanvasChoiceAnswersReviseCommand;
  try {
    command = Schema.decodeUnknownSync(CanvasChoiceAnswersReviseCommand)(input);
  } catch {
    return reject("malformed-request", "Canvas answers change is malformed.");
  }
  if (command.expectedSequence !== state.sequence) {
    return reject("stale-version", "The answers changed on the host; reload and try again.");
  }
  const events: CanvasChoiceAnswerEvent[] = [];
  for (const [index, change] of command.changes.entries()) {
    const block = head.blocks.find(
      (candidate): candidate is CanvasChoiceBlock =>
        candidate.kind === "choice" && String(candidate.blockId) === String(change.blockId),
    );
    const question = block?.questions.find((candidate) => candidate.id === change.questionId);
    if (question === undefined) {
      return reject("unknown-question", "That question is no longer in the Canvas.");
    }
    const sequence = state.sequence + index + 1;
    if (change.questionFingerprint !== canvasChoiceQuestionFingerprint(question)) {
      return reject("question-changed", "This question changed; reload to answer it again.");
    }
    if (change.kind === "clear") {
      events.push({
        kind: "cleared",
        event: {
          canvasId: command.canvasId,
          blockId: change.blockId,
          questionId: change.questionId,
          clearedBy: person,
          clearedAt: at,
          sequence,
        },
      });
      continue;
    }
    if (change.questionFingerprint !== canvasChoiceQuestionFingerprint(question)) {
      return reject("question-changed", "This question changed; reload to answer it again.");
    }
    if (!questionAnswerIsAllowed(question, change)) {
      return reject("invalid-answer", "That answer does not fit the question's choices.");
    }
    if (change.note !== undefined && question.allowNote === false) {
      return reject("invalid-answer", "This question takes no note.");
    }
    if (change.acceptedRecommendation === true && change.customAnswer !== undefined) {
      return reject("invalid-answer", "A written answer is not an accepted recommendation.");
    }
    events.push({
      kind: "set",
      event: {
        canvasId: command.canvasId,
        answer: {
          blockId: change.blockId,
          questionId: change.questionId,
          questionFingerprint: change.questionFingerprint,
          selectedOptionIds: change.selectedOptionIds,
          selectedLabels: question.options
            .filter((option) => change.selectedOptionIds.includes(option.id))
            .map((option) => option.label),
          ...(change.customAnswer === undefined ? {} : { customAnswer: change.customAnswer }),
          ...(change.note === undefined ? {} : { note: change.note }),
          ...(change.acceptedRecommendation === true ? { acceptedRecommendation: true } : {}),
          author: person,
          answeredAt: at,
        },
        sequence,
      },
    });
  }
  return { kind: "accepted", events };
}

/**
 * The option ids that accepting the agent's recommendation would select, or
 * nothing when the question has no unambiguous one: a single-choice question
 * needs exactly one recommended option, and a multiple-choice question needs
 * recommended options that satisfy its own selection limits.
 */
export function canvasChoiceRecommendedSelection(
  question: ChoiceQuestion,
): ReadonlyArray<string> | undefined {
  const recommended = question.options
    .filter((option) => option.recommended === true)
    .map((option) => option.id);
  if (recommended.length === 0) return undefined;
  if (question.selection === "single" && recommended.length !== 1) return undefined;
  return questionAnswerIsAllowed(question, { selectedOptionIds: recommended })
    ? recommended
    : undefined;
}

export interface CanvasChoiceQuestionState {
  readonly question: ChoiceQuestion;
  /** The saved answer, when it was made against the question as it reads now. */
  readonly answer: CanvasChoiceAnswer | undefined;
  /** An answer made against an earlier reading of the question. */
  readonly stale: CanvasChoiceAnswer | undefined;
  /** Optional (`minSelections` 0) and unanswered. */
  readonly skipped: boolean;
}

export interface CanvasChoiceFormState {
  readonly questions: ReadonlyArray<CanvasChoiceQuestionState>;
  readonly answered: number;
  readonly total: number;
  /** Every question is answered or optional. */
  readonly canSend: boolean;
}

/** Read a form's saved answers against its questions as they now read. */
export function canvasChoiceFormState(
  block: Pick<CanvasChoiceBlock, "blockId" | "questions">,
  answers: ReadonlyArray<CanvasChoiceAnswer>,
): CanvasChoiceFormState {
  const questions = block.questions.map((question): CanvasChoiceQuestionState => {
    const saved = answers.find((entry) => sameQuestion(entry, String(block.blockId), question.id));
    const current = saved?.questionFingerprint === canvasChoiceQuestionFingerprint(question);
    const answer = current ? saved : undefined;
    return {
      question,
      answer,
      stale: current ? undefined : saved,
      skipped: answer === undefined && question.minSelections === 0,
    };
  });
  return {
    questions,
    answered: questions.filter((entry) => entry.answer !== undefined).length,
    total: questions.length,
    canSend: questions.every((entry) => entry.answer !== undefined || entry.skipped),
  };
}
