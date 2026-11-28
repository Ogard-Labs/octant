import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Questionnaire } from "./questionnaire";
import { NativeHarnessAskUserArguments } from "./nativeHarness";
import { decodeHostAnswer } from "./hostAnswer";
const question = {
  id: "formats",
  prompt: "Which formats?",
  selection: "multiple",
  options: [
    { id: "pdf", label: "PDF" },
    { id: "md", label: "Markdown" },
  ],
};
describe("questionnaire contracts", () => {
  it("decodes bounded app-tool questionnaires and rejects unknown ask fields even in host answers", () => {
    expect(
      Schema.decodeUnknownSync(NativeHarnessAskUserArguments)({
        prompt: "Exports",
        questionnaire: { questions: [question] },
      }).questionnaire?.questions,
    ).toHaveLength(1);
    expect(() =>
      decodeHostAnswer(Questionnaire)({ questions: [{ ...question, futureAuthority: true }] }),
    ).toThrow();
  });
  it("decodes optional per-question headers, free-text questions, and more than eight options", () => {
    const decoded = Schema.decodeUnknownSync(Questionnaire)({
      allowComment: false,
      questions: [
        {
          id: "q0",
          header: "Database",
          prompt: "Which database?",
          selection: "single",
          options: Array.from({ length: 10 }, (_, index) => ({
            id: `o${index}`,
            label: `Option ${index + 1}`,
            ...(index === 0 ? { recommended: true } : {}),
          })),
        },
        {
          id: "q1",
          header: "Notes",
          prompt: "Any extra details?",
          selection: "single",
          options: [],
          allowCustom: true,
        },
      ],
    });
    expect(decoded.questions[0]?.header).toBe("Database");
    expect(decoded.questions[0]?.options).toHaveLength(10);
    expect(decoded.questions[1]?.options).toHaveLength(0);
    expect(() =>
      Schema.decodeUnknownSync(Questionnaire)({
        questions: [
          {
            id: "q1",
            prompt: "Impossible question",
            selection: "single",
            options: [],
            allowCustom: false,
          },
        ],
      }),
    ).toThrow();
  });
  it.each([
    { questions: [question, question] },
    { questions: [{ ...question, options: [question.options[0], question.options[0]] }] },
    { questions: [{ ...question, minSelections: 3 }] },
    { questions: [{ ...question, selection: "single", maxSelections: 2 }] },
    { questions: Array.from({ length: 5 }, (_, index) => ({ ...question, id: String(index) })) },
  ])("refuses ambiguous identities and invalid questionnaire limits", (value) => {
    expect(() => Schema.decodeUnknownSync(Questionnaire)(value)).toThrow();
  });
});
