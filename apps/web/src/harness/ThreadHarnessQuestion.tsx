import { useRetainQuestionnaireDrafts } from "../transcript/questionnaireDrafts";
import { QuestionnaireSummary } from "../transcript/QuestionnaireCard";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeHarnessSessionView } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import { ProviderQuestionCard } from "../transcript/ProviderQuestionCard";
import { OctantAlert } from "../ui/base/OctantAlert";
import "./native-harness.css";

export interface ThreadHarnessQuestionProps {
  readonly client: Pick<NativeHarnessClient, "answerQuestion">;
  readonly threadId: string;
  readonly view: NativeHarnessSessionView | null | undefined;
  readonly reload: () => Promise<unknown>;
}

/** The lead's live app question. Provider-native Code questions use their own card. */
export function threadLeadQuestion(view: NativeHarnessSessionView | null | undefined) {
  if (
    view === null ||
    view === undefined ||
    view.session.mode === "chat" ||
    view.session.status === "recovery-required"
  )
    return undefined;
  return view.questions.find(
    (entry) =>
      entry.status === "pending" &&
      entry.source === undefined &&
      (view.session.mode === "work" || entry.questionnaire !== undefined),
  );
}

/** Answers through the authenticated thread session and observes settlement on every window. */
export function ThreadHarnessQuestion(props: ThreadHarnessQuestionProps) {
  const { client, threadId, view, reload } = props;
  const [notice, setNotice] = useState<string>();
  const answering = useRef(false);

  const question = threadLeadQuestion(view);
  const draftScope = `harness:${threadId}`;
  useRetainQuestionnaireDrafts(
    draftScope,
    view === undefined
      ? undefined
      : view === null || view.session.status === "recovery-required"
        ? []
        : view.questions
            .filter((entry) => entry.status === "pending")
            .map((entry) => String(entry.id)),
  );

  useEffect(() => setNotice(undefined), [threadId, question?.id]);

  const answer = useCallback(
    async (text: string) => {
      // Legacy question cards can still submit twice before the host refreshes.
      if (question === undefined || answering.current) return false;
      answering.current = true;
      try {
        const result = await client.answerQuestion(threadId, {
          questionId: String(question.id),
          answer: text,
        });
        setNotice(result.kind === "question-refused" ? result.message : undefined);
        return result.kind === "question-answered";
      } catch {
        setNotice("The answer was not delivered. Try again.");
        return false;
      } finally {
        await reload();
        answering.current = false;
      }
    },
    [question, client, threadId, reload],
  );

  const submitted =
    view?.session.mode === "chat"
      ? []
      : (view?.questions.filter(
          (entry) =>
            entry.status === "answered" &&
            entry.source === undefined &&
            entry.questionnaire !== undefined,
        ) ?? []);
  if (question === undefined && submitted.length === 0) return null;
  return (
    <div className="thread-harness-question">
      {submitted.map((entry) =>
        entry.questionnaire === undefined || entry.answer === undefined ? null : (
          <QuestionnaireSummary
            key={String(entry.id)}
            prompt={entry.prompt}
            questionnaire={entry.questionnaire}
            answer={entry.answer}
          />
        ),
      )}
      {question === undefined ? null : (
        <ProviderQuestionCard
          key={String(question.id)}
          draftIdentity={{ scope: draftScope, requestId: String(question.id) }}
          questionnaire={question.questionnaire}
          onAnswer={answer}
          options={question.options.map((label) => ({ label }))}
          prompt={question.prompt}
        />
      )}
      {notice === undefined ? null : (
        <OctantAlert className="native-harness-panel__error" tone="warning">
          {notice}
        </OctantAlert>
      )}
    </div>
  );
}
