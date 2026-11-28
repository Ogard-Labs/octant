import { describe, expect, it } from "vitest";
import { answerProviderQuestionnaire, providerQuestionnaire } from "./providerQuestionnaire";

const question = {
  header: "Port",
  prompt: "Which port?",
  options: [{ label: "8080 (Recommended)" }, { label: "3000" }],
  multiple: false,
  allowCustom: true,
};

describe("a provider's question set as one questionnaire", () => {
  it("keeps a set whose long prompt holds an emoji, cut to the contract's own length", () => {
    const asked = providerQuestionnaire([{ ...question, prompt: `🚀${"x".repeat(1_100)}` }]);
    const prompt = asked?.questionnaire.questions[0]?.prompt ?? "";
    expect(prompt.length).toBeLessThanOrEqual(1_024);
    expect(prompt.startsWith("🚀")).toBe(true);
    expect(prompt.endsWith("…")).toBe(true);
  });

  it("takes a plain written answer to a one-question set even when it holds braces", () => {
    const asked = providerQuestionnaire([question]);
    if (asked === undefined) throw new Error("expected a questionnaire");
    expect(answerProviderQuestionnaire(asked, '{"port": 8080} please')).toEqual({
      status: "valid",
      answers: [['{"port": 8080} please']],
    });
  });

  it("refuses a card response that does not answer the set rather than passing it on as words", () => {
    const asked = providerQuestionnaire([question]);
    if (asked === undefined) throw new Error("expected a questionnaire");
    expect(
      answerProviderQuestionnaire(
        asked,
        JSON.stringify({ version: 1, answers: [{ questionId: "q9", selectedOptionIds: [] }] }),
      ),
    ).toEqual({ status: "invalid" });
  });

  it("answers with the provider's own label, recommendation mark included", () => {
    const asked = providerQuestionnaire([question]);
    if (asked === undefined) throw new Error("expected a questionnaire");
    expect(asked.questionnaire.questions[0]?.options[0]).toMatchObject({
      label: "8080",
      recommended: true,
    });
    expect(
      answerProviderQuestionnaire(
        asked,
        JSON.stringify({ version: 1, answers: [{ questionId: "q0", selectedOptionIds: ["o0"] }] }),
      ),
    ).toEqual({ status: "valid", answers: [["8080 (Recommended)"]] });
  });
});
