import { describe, expect, it } from "vitest";
import { validateCanvasChoiceAnswer, validateQuestionnaireAnswer } from "./questionnaire";

const questionnaire = {
  questions: [
    {
      id: "formats",
      prompt: "Which formats?",
      selection: "multiple" as const,
      options: [
        { id: "pdf", label: "PDF" },
        { id: "md", label: "Markdown" },
      ],
      maxSelections: 2,
    },
    {
      id: "open",
      prompt: "Open the file?",
      selection: "single" as const,
      options: [
        { id: "yes", label: "Open it" },
        { id: "no", label: "Save only" },
      ],
    },
  ],
};
const response = {
  version: 1,
  answers: [
    { questionId: "formats", selectedOptionIds: ["pdf", "md"] },
    { questionId: "open", selectedOptionIds: ["no"] },
  ],
  comment: "After the build finishes",
};

describe("questionnaire answers", () => {
  it("refuses a comment only when the question explicitly cannot receive one", () => {
    expect(
      validateQuestionnaireAnswer(
        { ...questionnaire, allowComment: false },
        JSON.stringify(response),
      ).status,
    ).toBe("invalid");
    const { comment: _comment, ...choices } = response;
    expect(
      validateQuestionnaireAnswer(
        { ...questionnaire, allowComment: false },
        JSON.stringify(choices),
      ).status,
    ).toBe("valid");
    expect(validateQuestionnaireAnswer(questionnaire, JSON.stringify(response)).status).toBe(
      "valid",
    );
  });
  it("accepts a complete selection set and a comment", () => {
    expect(validateQuestionnaireAnswer(questionnaire, JSON.stringify(response))).toEqual({
      status: "valid",
      response,
    });
  });
  it.each([
    { ...response, answers: response.answers.slice(0, 1) },
    { ...response, answers: [response.answers[0], response.answers[0]] },
    {
      ...response,
      answers: [{ questionId: "formats", selectedOptionIds: ["missing"] }, response.answers[1]],
    },
    {
      ...response,
      answers: [{ questionId: "formats", selectedOptionIds: ["pdf", "pdf"] }, response.answers[1]],
    },
    {
      ...response,
      answers: [response.answers[0], { questionId: "open", selectedOptionIds: ["yes", "no"] }],
    },
    {
      ...response,
      answers: [{ questionId: "formats", selectedOptionIds: [] }, response.answers[1]],
    },
    { ...response, permission: "full-access" },
  ])("refuses incomplete, duplicate, unknown or excessive choices", (invalid) => {
    expect(validateQuestionnaireAnswer(questionnaire, JSON.stringify(invalid)).status).toBe(
      "invalid",
    );
  });
  it("accepts a written alternative without silently selecting an option", () => {
    const alternative = {
      ...response,
      answers: [
        response.answers[0],
        { questionId: "open", selectedOptionIds: [], customAnswer: "Ask me after saving" },
      ],
    };
    expect(validateQuestionnaireAnswer(questionnaire, JSON.stringify(alternative)).status).toBe(
      "valid",
    );
    expect(
      validateQuestionnaireAnswer(
        { questions: questionnaire.questions.map((q) => ({ ...q, allowCustom: false })) },
        JSON.stringify(alternative),
      ).status,
    ).toBe("invalid");
  });
  it("permits an explicit empty selection only when the question allows it", () => {
    const empty = JSON.stringify({
      ...response,
      answers: [{ questionId: "formats", selectedOptionIds: [] }, response.answers[1]],
    });
    expect(
      validateQuestionnaireAnswer(
        {
          questions: questionnaire.questions.map((q) =>
            q.id === "formats" ? { ...q, minSelections: 0 } : q,
          ),
        },
        empty,
      ).status,
    ).toBe("valid");
  });
  it("refuses malformed and oversized input", () => {
    expect(validateQuestionnaireAnswer(questionnaire, "not JSON").status).toBe("invalid");
    expect(validateQuestionnaireAnswer(questionnaire, " ".repeat(16_385)).status).toBe("invalid");
  });
});

describe("Canvas choice answers", () => {
  const many = {
    allowComment: false,
    questions: Array.from({ length: 24 }, (_, n) => ({
      id: `q${String(n)}`,
      prompt: `Decision ${String(n)}`,
      selection: "single" as const,
      options: [{ id: "a", label: "A" }],
    })),
  };
  const answers = JSON.stringify({
    version: 1,
    answers: many.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: ["a"],
    })),
  });

  it("accepts an answer to every question of a long form that the inline rule refuses", () => {
    expect(validateCanvasChoiceAnswer(many, answers).status).toBe("valid");
    expect(validateQuestionnaireAnswer(many, answers).status).toBe("invalid");
  });

  it("still refuses a missing answer and an option the question never offered", () => {
    const missing = JSON.stringify({ version: 1, answers: JSON.parse(answers).answers.slice(1) });
    const unknown = JSON.stringify({
      version: 1,
      answers: JSON.parse(answers).answers.map((entry: object, index: number) =>
        index === 0 ? { ...entry, selectedOptionIds: ["zz"] } : entry,
      ),
    });
    expect(validateCanvasChoiceAnswer(many, missing).status).toBe("invalid");
    expect(validateCanvasChoiceAnswer(many, unknown).status).toBe("invalid");
  });
});
