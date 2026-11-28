import { describe, expect, it } from "vitest";
import { answerAcpElicitation, normalizeAcpElicitation } from "./acpElicitation";

const choices = [
  { const: "PDF", title: "PDF" },
  { const: "Text", title: "Text" },
];
const schema = {
  type: "object",
  required: ["native_single", "native_multi"],
  description: "Choose export formats",
  properties: {
    native_single: { type: "string", description: "Primary?", title: null, oneOf: choices },
    native_multi: { type: "array", description: "Additional?", items: { anyOf: choices } },
  },
};
const response = {
  version: 1,
  answers: [
    { questionId: "q0", selectedOptionIds: ["o1"] },
    { questionId: "q1", selectedOptionIds: ["o0", "o1"] },
  ],
};

describe("session forms", () => {
  it("keeps multiple selections and maps only validated local identities back to native labels", () => {
    const form = normalizeAcpElicitation("User input required", schema);
    expect(form?.questionnaire.allowComment).toBe(false);
    if (form === undefined) throw new Error("form missing");
    expect(answerAcpElicitation(form, JSON.stringify(response))).toEqual({
      status: "valid",
      content: { native_single: "Text", native_multi: ["PDF", "Text"] },
    });
    expect(
      answerAcpElicitation(form, JSON.stringify({ ...response, comment: "not transportable" })),
    ).toEqual({ status: "invalid" });
    expect(
      answerAcpElicitation(
        form,
        JSON.stringify({ ...response, answers: [response.answers[1], response.answers[1]] }),
      ),
    ).toEqual({ status: "invalid" });
    expect(
      answerAcpElicitation(
        form,
        JSON.stringify({
          version: 1,
          answers: [
            { questionId: "q0", selectedOptionIds: [], customAnswer: "CSV" },
            { questionId: "q1", selectedOptionIds: [], customAnswer: "XML" },
          ],
        }),
      ),
    ).toEqual({ status: "valid", content: { native_single: "CSV", native_multi: ["XML"] } });
  });

  it("preserves option descriptions, short headers, and recommended markers", () => {
    const described = normalizeAcpElicitation("Choose setup", {
      type: "object",
      required: ["db"],
      properties: {
        db: {
          type: "string",
          title: "Database",
          description: "Which database should we configure?",
          oneOf: [
            {
              const: "PostgreSQL (Recommended)",
              title: "PostgreSQL (Recommended)",
              description: "Managed relational store",
            },
            { const: "SQLite", title: "SQLite", description: "Embedded file store" },
          ],
        },
      },
    });
    expect(described?.questionnaire).toEqual({
      allowComment: false,
      questions: [
        {
          id: "q0",
          header: "Database",
          prompt: "Which database should we configure?",
          selection: "single",
          options: [
            {
              id: "o0",
              label: "PostgreSQL",
              description: "Managed relational store",
              recommended: true,
            },
            { id: "o1", label: "SQLite", description: "Embedded file store" },
          ],
          allowCustom: true,
        },
      ],
    });
    if (described === undefined) throw new Error("form missing");
    expect(
      answerAcpElicitation(
        described,
        JSON.stringify({
          version: 1,
          answers: [{ questionId: "q0", selectedOptionIds: ["o0"] }],
        }),
      ),
    ).toEqual({
      status: "valid",
      content: { db: "PostgreSQL (Recommended)" },
    });
  });

  it("refuses unsupported, oversized and ambiguous forms instead of truncating the ask", () => {
    expect(
      normalizeAcpElicitation("Question", { ...schema, required: ["native_single"] }),
    ).toBeUndefined();
    expect(
      normalizeAcpElicitation("Question", {
        ...schema,
        properties: {
          native_single: {
            type: "string",
            description: "Choose",
            oneOf: choices,
            pattern: "^secret$",
          },
        },
        required: ["native_single"],
      }),
    ).toBeUndefined();
    expect(
      normalizeAcpElicitation("Question", {
        ...schema,
        properties: {
          native_single: {
            type: "string",
            description: "Choose",
            oneOf: Array.from({ length: 33 }, (_, i) => ({ const: String(i) })),
          },
        },
        required: ["native_single"],
      }),
    ).toBeUndefined();
    expect(
      normalizeAcpElicitation("Question", {
        ...schema,
        properties: { native_single: { type: "boolean", description: "Choose" } },
        required: ["native_single"],
      }),
    ).toBeUndefined();
  });
});
