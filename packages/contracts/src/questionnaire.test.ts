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
