import { describe, expect, it } from "vitest";
import type { Questionnaire } from "@octant/contracts";
import {
  chooseQuestionnaireOption,
  emptyQuestionnaireDraft,
  forgetSettledQuestionnaireDrafts,
  heldQuestionnaireDraft,
  holdQuestionnaireDraft,
  plainAnswerOf,
  plainQuestionnaire,
  questionnaireDraftKey,
  questionnaireResponseOf,
  writeQuestionnaireAnswer,
} from "./questionnaireDraft";

const questionnaire: Questionnaire = {
  questions: [
    {
      id: "venue",
      header: "Venue",
      prompt: "Which venue?",
      selection: "single",
      options: [
        { id: "a", label: "Hall A" },
        { id: "b", label: "Hall B" },
      ],
    },
    {
      id: "extras",
      prompt: "Which extras?",
      selection: "multiple",
      maxSelections: 2,
      options: [
        { id: "x", label: "Coffee" },
        { id: "y", label: "Lunch" },
        { id: "z", label: "Dinner" },
      ],
    },
  ],
};
const [venue, extras] = questionnaire.questions;
if (venue === undefined || extras === undefined) throw new Error("fixture");

describe("a questionnaire answered on the phone", () => {
  it("offers to send only once every question meets its limits", () => {
    let draft = emptyQuestionnaireDraft(questionnaire);
    expect(questionnaireResponseOf(questionnaire, draft)).toBeUndefined();
    draft = chooseQuestionnaireOption(draft, venue, "a");
    draft = chooseQuestionnaireOption(draft, venue, "b");
    draft = chooseQuestionnaireOption(draft, extras, "x");
    draft = chooseQuestionnaireOption(draft, extras, "y");
    // A third extra is past the question's limit and is not taken.
    draft = chooseQuestionnaireOption(draft, extras, "z");
    expect(questionnaireResponseOf(questionnaire, { ...draft, comment: "  Thanks " })).toEqual({
      version: 1,
      answers: [
        { questionId: "venue", selectedOptionIds: ["b"] },
        { questionId: "extras", selectedOptionIds: ["x", "y"] },
      ],
      comment: "Thanks",
    });
  });

  it("takes a written answer in place of the question's options", () => {
    let draft = chooseQuestionnaireOption(emptyQuestionnaireDraft(questionnaire), venue, "a");
    draft = chooseQuestionnaireOption(draft, extras, "x");
    draft = writeQuestionnaireAnswer(draft, venue, "  The rooftop ");
    expect(questionnaireResponseOf(questionnaire, draft)?.answers[0]).toEqual({
      questionId: "venue",
      selectedOptionIds: [],
      customAnswer: "The rooftop",
    });
    // Choosing again lets the written words go.
    draft = chooseQuestionnaireOption(draft, venue, "b");
    expect(questionnaireResponseOf(questionnaire, draft)?.answers[0]).toEqual({
      questionId: "venue",
      selectedOptionIds: ["b"],
    });
  });

  it("refuses a written answer where the question takes none", () => {
    const strict: Questionnaire = {
      questions: [{ ...venue, allowCustom: false }],
    };
    const [only] = strict.questions;
    if (only === undefined) throw new Error("fixture");
    const draft = writeQuestionnaireAnswer(emptyQuestionnaireDraft(strict), only, "Elsewhere");
    expect(questionnaireResponseOf(strict, draft)).toBeUndefined();
  });
});

describe("a plain question answered on the phone", () => {
  it("sends the option exactly as offered, or the written words", () => {
    const options = ["Hall A", "Hall B (Recommended)"];
    const plain = plainQuestionnaire("Which venue?", options);
    const [question] = plain.questions;
    if (question === undefined) throw new Error("fixture");
    expect(question.options[1]).toEqual({ id: "o1", label: "Hall B", recommended: true });
    let draft = emptyQuestionnaireDraft(plain);
    expect(plainAnswerOf(options, draft)).toBeUndefined();
    draft = chooseQuestionnaireOption(draft, question, "o1");
    expect(plainAnswerOf(options, draft)).toBe("Hall B (Recommended)");
    draft = writeQuestionnaireAnswer(draft, question, "The rooftop");
    expect(plainAnswerOf(options, draft)).toBe("The rooftop");
  });
});

describe("an unsent questionnaire draft", () => {
  it("is kept for the same request and definition, and dropped when the definition changes", () => {
    const key = questionnaireDraftKey("host", "work", "thread", "request-1");
    const draft = chooseQuestionnaireOption(emptyQuestionnaireDraft(questionnaire), venue, "a");
    holdQuestionnaireDraft(key, questionnaire, draft);
    expect(heldQuestionnaireDraft(key, questionnaire)).toEqual(draft);
    const changed: Questionnaire = { ...questionnaire, allowComment: false };
    expect(heldQuestionnaireDraft(key, changed)).toBeUndefined();
    expect(heldQuestionnaireDraft(key, questionnaire)).toBeUndefined();
  });

  it("is forgotten once its request no longer waits, leaving other threads' drafts", () => {
    const scope = questionnaireDraftKey("host", "chat", "thread-a");
    const waiting = questionnaireDraftKey(scope, "kept");
    const settled = questionnaireDraftKey(scope, "settled");
    const elsewhere = questionnaireDraftKey("host", "chat", "thread-b", "other");
    const draft = emptyQuestionnaireDraft(questionnaire);
    for (const key of [waiting, settled, elsewhere])
      holdQuestionnaireDraft(key, questionnaire, draft);
    forgetSettledQuestionnaireDrafts(scope, [waiting]);
    expect(heldQuestionnaireDraft(waiting, questionnaire)).toEqual(draft);
    expect(heldQuestionnaireDraft(settled, questionnaire)).toBeUndefined();
    expect(heldQuestionnaireDraft(elsewhere, questionnaire)).toEqual(draft);
  });
});
