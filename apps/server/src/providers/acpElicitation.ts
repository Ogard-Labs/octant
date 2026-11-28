import { Schema } from "effect";
import { Questionnaire, type QuestionnaireResponse } from "@octant/contracts";
import { validateQuestionnaireAnswer } from "@octant/domain";

const Choice = Schema.Struct({
  const: Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.check(Schema.isMaxLength(256))),
  title: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.check(Schema.isMaxLength(256))),
  ),
});
const Choices = Schema.Array(Choice).pipe(
  Schema.check(Schema.isMinLength(2)),
  Schema.check(Schema.isMaxLength(8)),
);
const Header = {
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
    Schema.check(Schema.isMaxLength(1_024)),
  ),
};
const Field = Schema.Union([
  Schema.Struct({ type: Schema.Literal("string"), ...Header, oneOf: Choices }),
  Schema.Struct({
    type: Schema.Literal("array"),
    ...Header,
    items: Schema.Struct({ anyOf: Choices }),
  }),
]);
const Form = Schema.Struct({
  type: Schema.Literal("object"),
  properties: Schema.Record(Schema.String, Field),
  required: Schema.Array(Schema.String).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4)),
  ),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface AcpElicitation {
  readonly prompt: string;
  readonly questionnaire: Questionnaire;
  readonly fields: ReadonlyArray<{
    readonly key: string;
    readonly questionId: string;
    readonly labels: ReadonlyArray<string>;
    readonly multiple: boolean;
  }>;
}

/** Only the session-form dialect emitted by the verified native runtime. */
export function normalizeAcpElicitation(
  message: string,
  schema: unknown,
): AcpElicitation | undefined {
  try {
    const form = Schema.decodeUnknownSync(Form, { onExcessProperty: "error" })(schema);
    const keys = Object.keys(form.properties);
    if (
      keys.length !== form.required.length ||
      new Set(form.required).size !== keys.length ||
      keys.some(
        (key) =>
          !form.required.includes(key) ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(key) ||
          ["__proto__", "constructor", "prototype"].includes(key),
      )
    )
      return undefined;
    const fields = keys.map((key, index) => {
      const field = form.properties[key];
      if (field === undefined) throw new Error("missing field");
      const choices = field.type === "string" ? field.oneOf : field.items.anyOf;
      if (
        choices.some((choice) => choice.title !== undefined && choice.title !== choice.const) ||
        new Set(choices.map((choice) => choice.const)).size !== choices.length
      )
        throw new Error("duplicate choice");
      return {
        key,
        questionId: `q${index}`,
        labels: choices.map((choice) => choice.const),
        multiple: field.type === "array",
        question: {
          id: `q${index}`,
          prompt: [field.title, field.description].filter(Boolean).join("\n"),
          selection: field.type === "array" ? ("multiple" as const) : ("single" as const),
          options: choices.map((choice, choiceIndex) => ({
            id: `o${choiceIndex}`,
            label: choice.const,
          })),
          allowCustom: true,
        },
      };
    });
    const prompt = [message, form.description].filter(Boolean).join("\n");
    if (prompt.trim().length === 0 || prompt.length > 2_000) return undefined;
    return {
      prompt,
      questionnaire: Schema.decodeUnknownSync(Questionnaire, { onExcessProperty: "error" })({
        allowComment: false,
        questions: fields.map((field) => field.question),
      }),
      fields,
    };
  } catch {
    return undefined;
  }
}

export function answerAcpElicitation(
  form: AcpElicitation,
  text: string,
):
  | { readonly status: "invalid" }
  | {
      readonly status: "valid";
      readonly content: Readonly<Record<string, string | ReadonlyArray<string>>>;
    } {
  const answer = validateQuestionnaireAnswer(form.questionnaire, text);
  if (answer.status !== "valid") return { status: "invalid" };
  return {
    status: "valid",
    content: Object.fromEntries(
      form.fields.map((field) => [field.key, fieldAnswer(field, answer.response)]),
    ),
  };
}

function fieldAnswer(
  field: AcpElicitation["fields"][number],
  response: QuestionnaireResponse,
): string | ReadonlyArray<string> {
  const answer = response.answers.find((entry) => entry.questionId === field.questionId);
  if (answer === undefined) throw new Error("validated answer is missing");
  const values =
    answer.customAnswer === undefined
      ? answer.selectedOptionIds.map((id) => {
          const label = field.labels[Number(id.slice(1))];
          if (label === undefined) throw new Error("validated option is missing");
          return label;
        })
      : [answer.customAnswer];
  return field.multiple ? values : (values[0] ?? "");
}
