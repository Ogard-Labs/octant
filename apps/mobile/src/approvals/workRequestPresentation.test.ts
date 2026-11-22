import { describe, expect, it } from "vitest";
import { decodeWorkRequest, type Questionnaire } from "@octant/contracts";
import {
  chooseQuestionnaireOption,
  emptyQuestionnaireDraft,
  pendingWorkRequestsInOrder,
  questionnaireResponseOf,
  toggleQuestionnaireCustom,
  workRequestCard,
  writeQuestionnaireCustom,
} from "./workRequestPresentation";

const base = {
  projectId: "20000000-0000-4000-8000-000000000001",
  threadId: "00000000-0000-4000-8000-000000000201",
  providerInstanceId: "10000000-0000-4000-8000-000000000001",
  providerSessionId: "55555555-5555-4555-8555-555555555555",
  providerRequestId: "provider-req",
  status: "pending",
  version: 1,
} as const;

const request = (id: string, requestedAt: string, detail: unknown) =>
  decodeWorkRequest({
    ...base,
    requestId: `${id}-1111-4111-8111-111111111111`,
    requestedAt,
    detail,
  });

describe("which card a Work request draws on the phone", () => {
  it("draws a tool call as the desktop's provider approval, and a level change as the Plan block", () => {
    expect(
      workRequestCard(
        request("11111111", "2026-11-18T10:00:00.000Z", {
          kind: "approval",
          action: "Run command",
          description: "npm test",
        }),
      ),
    ).toEqual({
      kind: "tool-approval",
      label: "Provider approval",
      summary: "Run command: npm test",
    });
    expect(
      workRequestCard(
        request("22222222", "2026-11-18T10:00:00.000Z", {
          kind: "approval",
          action: "enter-plan",
          description: "Plan first.",
          levelChange: { to: "plan" },
        }),
      )?.kind,
    ).toBe("level-change");
  });

  it("draws a question as one question, or as a questionnaire when the provider sent one", () => {
    expect(
      workRequestCard(
        request("33333333", "2026-11-18T10:00:00.000Z", {
          kind: "user-input",
          prompt: "Which venue?",
          options: ["Hall A", "Hall B"],
        }),
      ),
    ).toEqual({ kind: "question", prompt: "Which venue?", options: ["Hall A", "Hall B"] });
  });

  it("lists the oldest ask first", () => {
    const later = request("44444444", "2026-11-18T10:05:00.000Z", {
      kind: "user-input",
      prompt: "Later",
      options: [],
    });
    const earlier = request("55555555", "2026-11-18T10:00:00.000Z", {
      kind: "user-input",
      prompt: "Earlier",
      options: [],
    });
    expect(pendingWorkRequestsInOrder([later, earlier]).map((entry) => entry.requestId)).toEqual([
      earlier.requestId,
      later.requestId,
    ]);
  });
});

const questionnaire: Questionnaire = {
  questions: [
    {
      id: "venue",
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

  it("holds a written answer back until the person has written it", () => {
    let draft = chooseQuestionnaireOption(emptyQuestionnaireDraft(questionnaire), extras, "x");
    draft = toggleQuestionnaireCustom(draft, venue);
    expect(questionnaireResponseOf(questionnaire, draft)).toBeUndefined();
    draft = writeQuestionnaireCustom(draft, venue, "The rooftop");
    expect(questionnaireResponseOf(questionnaire, draft)?.answers[0]).toEqual({
      questionId: "venue",
      selectedOptionIds: [],
      customAnswer: "The rooftop",
    });
  });
});
