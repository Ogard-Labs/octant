import { decodeCanvasBlock, type CanvasChoiceBlock } from "@octant/contracts/canvas";
import { decodeCanvasActor } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  EMPTY_CANVAS_CHOICE_ANSWER_STATE,
  admitCanvasChoiceAnswersRevision,
  applyCanvasChoiceAnswerEvent,
  canvasChoiceFormState,
  canvasChoiceQuestionFingerprint,
  canvasChoiceRecommendedSelection,
} from "./canvasChoiceAnswerPolicy";

const canvasId = "11111111-1111-4111-8111-111111111111";
const person = decodeCanvasActor({ kind: "local-user", actorId: "22222222-2222-4222-8222-222222222222" });
const at = "2026-11-12T10:00:00.000Z" as never;

const block = decodeCanvasBlock({
  blockId: "decisions",
  schemaVersion: 29,
  kind: "choice",
  prompt: "Decisions",
  questions: [
    {
      id: "who",
      prompt: "Who may set it?",
      selection: "single",
      options: [
        { id: "any", label: "Any device", recommended: true },
        { id: "owner", label: "Owner devices" },
      ],
    },
    {
      id: "reach",
      prompt: "How far?",
      selection: "multiple",
      options: [
        { id: "a", label: "A", recommended: true },
        { id: "b", label: "B", recommended: true },
        { id: "c", label: "C" },
      ],
      allowNote: false,
    },
    {
      id: "optional",
      prompt: "Anything else?",
      selection: "single",
      minSelections: 0,
      options: [{ id: "x", label: "X" }],
    },
  ],
}) as CanvasChoiceBlock;
const head = { blocks: [block] };
const [who, reach] = block.questions;
if (who === undefined || reach === undefined) throw new Error("fixture");

const set = (overrides: Record<string, unknown> = {}) => ({
  kind: "set",
  blockId: "decisions",
  questionId: "who",
  questionFingerprint: canvasChoiceQuestionFingerprint(who),
  selectedOptionIds: ["any"],
  ...overrides,
});
const revise = (changes: ReadonlyArray<unknown>, expectedSequence = 0) => ({
  kind: "canvas-choice-answers-revise",
  canvasId,
  expectedSequence,
  changes,
});
const admit = (input: unknown, state = EMPTY_CANVAS_CHOICE_ANSWER_STATE) =>
  admitCanvasChoiceAnswersRevision(input, head, state, person, at);

describe("Canvas choice answers", () => {
  it("admits a batch of picks in order as the host's own, replacing an earlier answer", () => {
    const admitted = admit(
      revise([
        set(),
        set({
          questionId: "reach",
          questionFingerprint: canvasChoiceQuestionFingerprint(reach),
          selectedOptionIds: ["a", "b"],
          acceptedRecommendation: true,
        }),
      ]),
    );
    if (admitted.kind !== "accepted") throw new Error(admitted.message);
    expect(admitted.events.map((event) => event.event.sequence)).toEqual([1, 2]);
    const state = admitted.events.reduce(
      applyCanvasChoiceAnswerEvent,
      EMPTY_CANVAS_CHOICE_ANSWER_STATE,
    );
    expect(state.sequence).toBe(2);
    expect(state.answers.map((answer) => answer.author)).toEqual([person, person]);

    const changed = admit(revise([set({ selectedOptionIds: ["owner"] })], 2), state);
    if (changed.kind !== "accepted") throw new Error(changed.message);
    const next = changed.events.reduce(applyCanvasChoiceAnswerEvent, state);
    expect(next.answers.filter((answer) => answer.questionId === "who")).toHaveLength(1);
    expect(next.answers.find((answer) => answer.questionId === "who")?.selectedOptionIds).toEqual([
      "owner",
    ]);
  });

  it("refuses a write against an old sequence, so two windows never both win", () => {
    expect(admit(revise([set()], 3))).toMatchObject({ kind: "rejected", code: "stale-version" });
  });

  it("refuses an answer to a question the agent has since changed", () => {
    expect(admit(revise([set({ questionFingerprint: "old" })]))).toMatchObject({
      kind: "rejected",
      code: "question-changed",
    });
  });

  it("refuses a question that is not in the Canvas, an option it never offered, and a note it withholds", () => {
    expect(admit(revise([set({ questionId: "gone" })]))).toMatchObject({
      code: "unknown-question",
    });
    expect(admit(revise([set({ selectedOptionIds: ["nope"] })]))).toMatchObject({
      code: "invalid-answer",
    });
    expect(
      admit(
        revise([
          set({
            questionId: "reach",
            questionFingerprint: canvasChoiceQuestionFingerprint(reach),
            selectedOptionIds: ["a"],
            note: "why",
          }),
        ]),
      ),
    ).toMatchObject({ code: "invalid-answer" });
  });

  it("applies none of a batch when one change is refused", () => {
    expect(admit(revise([set(), set({ selectedOptionIds: ["nope"] })]))).toMatchObject({
      kind: "rejected",
    });
  });

  it("clears an answer", () => {
    const first = admit(revise([set()]));
    if (first.kind !== "accepted") throw new Error(first.message);
    const state = first.events.reduce(
      applyCanvasChoiceAnswerEvent,
      EMPTY_CANVAS_CHOICE_ANSWER_STATE,
    );
    const cleared = admit(
      revise([{ kind: "clear", blockId: "decisions", questionId: "who" }], 1),
      state,
    );
    if (cleared.kind !== "accepted") throw new Error(cleared.message);
    expect(cleared.events.reduce(applyCanvasChoiceAnswerEvent, state).answers).toEqual([]);
  });

  it("recommends only where the recommendation is unambiguous and allowed", () => {
    expect(canvasChoiceRecommendedSelection(who)).toEqual(["any"]);
    expect(canvasChoiceRecommendedSelection(reach)).toEqual(["a", "b"]);
    expect(
      canvasChoiceRecommendedSelection({
        ...who,
        options: who.options.map((option) => ({ ...option, recommended: true })),
      }),
    ).toBeUndefined();
    expect(
      canvasChoiceRecommendedSelection({ ...who, options: [{ id: "a", label: "A" }] }),
    ).toBeUndefined();
  });

  it("counts an answer made against a question that has since changed as stale and unanswered", () => {
    const first = admit(revise([set()]));
    if (first.kind !== "accepted") throw new Error(first.message);
    const state = first.events.reduce(
      applyCanvasChoiceAnswerEvent,
      EMPTY_CANVAS_CHOICE_ANSWER_STATE,
    );
    expect(canvasChoiceFormState(block, state.answers)).toMatchObject({
      answered: 1,
      total: 3,
      canSend: false,
    });
    const revised = {
      ...block,
      questions: [{ ...who, prompt: "Who, now?" }, ...block.questions.slice(1)],
    };
    const form = canvasChoiceFormState(revised, state.answers);
    expect(form.answered).toBe(0);
    expect(form.questions[0]?.stale?.questionId).toBe("who");
    expect(form.questions[2]?.skipped).toBe(true);
  });
});
