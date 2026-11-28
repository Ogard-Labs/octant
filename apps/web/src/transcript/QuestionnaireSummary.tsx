import type { Questionnaire } from "@octant/contracts";
import { validateQuestionnaireAnswer, type QuestionnaireAnswerValidation } from "@octant/domain";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";

export type QuestionnaireAnswerRule = (
  questionnaire: Questionnaire,
  text: string,
) => QuestionnaireAnswerValidation;

export function QuestionnaireSummary(props: {
  readonly prompt: string;
  readonly questionnaire: Questionnaire;
  readonly answer: string;
  readonly validateAnswer?: QuestionnaireAnswerRule | undefined;
}) {
  const validated = (props.validateAnswer ?? validateQuestionnaireAnswer)(
    props.questionnaire,
    props.answer,
  );
  if (validated.status === "invalid")
    return <p role="status">Submitted answers are unavailable.</p>;
  return (
    <OctantCollapsible className="questionnaire-summary" summary={`Answers sent · ${props.prompt}`}>
      <dl>
        {props.questionnaire.questions.map((question) => {
          const answer = validated.response.answers.find(
            (entry) => entry.questionId === question.id,
          );
          const text =
            answer?.customAnswer ??
            question.options
              .filter((option) => answer?.selectedOptionIds.includes(option.id))
              .map((option) => option.label)
              .join(", ");
          return (
            <div key={question.id}>
              <dt>
                {question.header === undefined ? null : (
                  <span className="questionnaire__header">{question.header}</span>
                )}
                {question.prompt}
              </dt>
              <dd>{text || "None selected"}</dd>
            </div>
          );
        })}
        {validated.response.comment === undefined ? null : (
          <div>
            <dt>Comment</dt>
            <dd>{validated.response.comment}</dd>
          </div>
        )}
      </dl>
    </OctantCollapsible>
  );
}
